import { S3DocumentStorage } from "@locum/integrations";
import { assertProductionReady, loadConfig } from "./config";
import { buildServer } from "./server";

const config = loadConfig();

/*
 * Real S3 when it is configured, the in-memory store otherwise.
 *
 * All four values are required together — a bucket with no credentials, or a
 * bucket with no KMS key, is a misconfiguration rather than a partial setup,
 * and falling back to the in-memory store on a half-set config would look like
 * a working upload feature that loses every document on restart.
 */
const documentStorage =
  config.S3_BUCKET &&
  config.S3_KMS_KEY_ID &&
  config.AWS_ACCESS_KEY_ID &&
  config.AWS_SECRET_ACCESS_KEY
    ? new S3DocumentStorage({
        bucket: config.S3_BUCKET,
        region: config.S3_REGION,
        kmsKeyId: config.S3_KMS_KEY_ID,
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      })
    : undefined;

/*
 * The scanner is still the stub — §15 classes a real scanning service as
 * externally blocked, and §12.1 requires uploads to be scanned BEFORE storage.
 * So production still refuses to boot, and it now says which of the two is
 * missing rather than naming both.
 */
assertProductionReady(config, {
  usingStubStorage: documentStorage === undefined,
  usingStubScanner: true,
});

const { app, client } = await buildServer(
  config,
  // Spread rather than passing `documentStorage: undefined` — under
  // exactOptionalPropertyTypes an explicit undefined is not the same as an
  // absent property, and the absent one is what "fall back to the stub" means.
  documentStorage ? { documentStorage } : {},
);

/**
 * Graceful shutdown.
 *
 * ECS sends SIGTERM and then waits before SIGKILL. Draining in-flight requests
 * matters here specifically because a booking confirmation killed mid
 * transaction leaves the manager with no answer about whether their pharmacy
 * has cover tomorrow.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app
      .close()
      .then(() => client.end())
      .then(() => process.exit(0))
      .catch((error) => {
        app.log.error({ error }, "error during shutdown");
        process.exit(1);
      });
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error({ error }, "failed to start");
  process.exit(1);
}

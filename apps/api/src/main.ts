import { ClamavDocumentScanner, S3DocumentStorage } from "@locum/integrations";
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
 * Real clamd when it is configured, the EICAR-only stub otherwise.
 *
 * §12.1 requires uploads to be scanned BEFORE storage, and `uploadDocument`
 * awaits the scan before writing — so a scanner that throws fails the upload
 * rather than storing an unexamined file. That is the behaviour the adapter is
 * built around and why it has no "unknown" verdict.
 */
const documentScanner = config.CLAMD_HOST
  ? new ClamavDocumentScanner({ host: config.CLAMD_HOST, port: config.CLAMD_PORT })
  : undefined;

assertProductionReady(config, {
  usingStubStorage: documentStorage === undefined,
  usingStubScanner: documentScanner === undefined,
});

const { app, client } = await buildServer(config, {
  // Spread rather than passing an explicit `undefined` — under
  // exactOptionalPropertyTypes those are not the same, and the absent property
  // is what "fall back to the stub" means.
  ...(documentStorage ? { documentStorage } : {}),
  ...(documentScanner ? { documentScanner } : {}),
});

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

import { assertProductionReady, loadConfig } from "./config";
import { buildServer } from "./server";

const config = loadConfig();

/*
 * No real storage or scanner adapters exist yet (§15 classes them as
 * externally blocked — they need an S3 bucket and a scanning service), so the
 * stubs are what buildServer will fall back to. assertProductionReady is told
 * that explicitly, and refuses to start in production because of it. When the
 * real adapters land, construct them here and pass them in.
 */
assertProductionReady(config, { usingStubDocumentDeps: true });

const { app, client } = await buildServer(config);

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

import {
  ClamavDocumentScanner,
  S3DocumentStorage,
  TwilioWhatsAppSender,
  type SseConfig,
} from "@locum/integrations";
import { assertProductionReady, loadConfig } from "./config";
import { buildServer } from "./server";

const config = loadConfig();

/*
 * The encryption mode, resolved explicitly rather than guessed from which
 * fields happen to be set.
 *
 * `aws-kms` needs a key; `provider-managed` (R2/B2 on the Railway path) does
 * not, because those providers encrypt at rest under a key they manage and
 * have no bucket-side slot for a customer key at all. An `S3_SSE_MODE` set to
 * `aws-kms` with no `S3_KMS_KEY_ID` is a misconfiguration, not a fallback —
 * `sse` below is left `undefined` and storage falls back to the in-memory
 * stub, which `assertProductionReady` then refuses in production.
 */
const sse: SseConfig | undefined =
  config.S3_SSE_MODE === "aws-kms" && config.S3_KMS_KEY_ID
    ? { mode: "aws-kms", kmsKeyId: config.S3_KMS_KEY_ID }
    : config.S3_SSE_MODE === "provider-managed"
      ? { mode: "provider-managed" }
      : undefined;

/*
 * Real S3-compatible storage when it is fully configured, the in-memory store
 * otherwise.
 *
 * Bucket, credentials and a resolved encryption mode are required together —
 * a bucket with credentials but no valid `sse` is a misconfiguration rather
 * than a partial setup, and falling back to the in-memory store on a half-set
 * config would look like a working upload feature that loses every document
 * on restart.
 */
const documentStorage =
  config.S3_BUCKET && config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY && sse
    ? new S3DocumentStorage({
        bucket: config.S3_BUCKET,
        region: config.S3_REGION,
        sse,
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
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

/*
 * §11.1/§12.3 — the real Twilio sender when it is configured.
 *
 * Content SIDs do not exist until Meta approves each template (§15 lists that
 * as externally blocked), so they arrive as JSON from the environment rather
 * than being hard-coded. A missing SID makes the adapter throw rather than
 * fall back to a free-form send, which Meta would reject outside the 24-hour
 * window while looking successful from here.
 */
const whatsappSender =
  config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM_NUMBER
    ? new TwilioWhatsAppSender({
        accountSid: config.TWILIO_ACCOUNT_SID,
        authToken: config.TWILIO_AUTH_TOKEN,
        fromNumber: config.TWILIO_FROM_NUMBER,
        statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/twilio/status`,
        contentSids: config.TWILIO_CONTENT_SIDS,
      })
    : undefined;

assertProductionReady(config, {
  usingStubStorage: documentStorage === undefined,
  usingStubScanner: documentScanner === undefined,
  usingFakeWhatsAppSender: whatsappSender === undefined,
});

const { app, client } = await buildServer(config, {
  // Spread rather than passing an explicit `undefined` — under
  // exactOptionalPropertyTypes those are not the same, and the absent property
  // is what "fall back to the stub" means.
  ...(documentStorage ? { documentStorage } : {}),
  ...(documentScanner ? { documentScanner } : {}),
  ...(whatsappSender ? { whatsappSender } : {}),
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

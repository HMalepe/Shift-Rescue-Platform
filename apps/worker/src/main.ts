import pino from "pino";
import { createDatabase } from "@locum/db";
import {
  FakePaymentProvider,
  FakeWhatsAppSender,
  type PaymentProvider,
  type WhatsAppSender,
} from "@locum/core";
import { PayfastPaymentProvider, TwilioWhatsAppSender } from "@locum/integrations";
import { NoopReporter, WebhookReporter, type ErrorReporter } from "@locum/observability";
import { assertWorkerProductionReady, loadWorkerConfig } from "./config";
import { registerSchedules, startScheduler } from "./scheduler";

const config = loadWorkerConfig();
const log = pino({ level: config.NODE_ENV === "production" ? "info" : "debug" });

/*
 * Both real adapters are used the moment they are fully configured, and the
 * fakes are the local-dev fallback. §15 still classes both as unverified
 * against a live vendor: no Twilio sender has ever sent a real WhatsApp
 * message and no Payfast credential set has ever reached the real API from
 * here — but the wiring itself is real, not a placeholder waiting to be
 * written.
 *
 * `assertWorkerProductionReady` refuses to boot production on whichever of
 * the two ends up on the fake — a worker running the fake payment provider
 * settles charges that were never charged, and reports healthy while doing
 * it, which is the worst failure shape this service has.
 */
/*
 * The real sender is used the moment it is fully configured. "Fully" is the
 * operative word: a partial Twilio configuration silently falling back to the
 * fake would be the worst of both worlds — production-looking config, and
 * every message marked sent while nothing arrives.
 */
const twilioConfigured =
  config.TWILIO_ACCOUNT_SID !== undefined &&
  config.TWILIO_AUTH_TOKEN !== undefined &&
  config.TWILIO_WHATSAPP_FROM !== undefined &&
  config.TWILIO_STATUS_CALLBACK_URL !== undefined;

const sender: WhatsAppSender = twilioConfigured
  ? new TwilioWhatsAppSender({
      accountSid: config.TWILIO_ACCOUNT_SID!,
      authToken: config.TWILIO_AUTH_TOKEN!,
      fromNumber: config.TWILIO_WHATSAPP_FROM!,
      statusCallbackUrl: config.TWILIO_STATUS_CALLBACK_URL!,
      contentSids: config.TWILIO_CONTENT_SIDS,
    })
  : new FakeWhatsAppSender();

/*
 * Same "fully configured or not at all" rule as Twilio above. The passphrase
 * is technically optional in Payfast's own docs and required in practice —
 * see the note on `PayfastConfig.passphrase` — so it is required here too,
 * rather than letting a merchant id and key alone produce a provider that
 * signs every request wrong.
 */
const payfastConfigured =
  config.PAYFAST_MERCHANT_ID !== undefined &&
  config.PAYFAST_MERCHANT_KEY !== undefined &&
  config.PAYFAST_PASSPHRASE !== undefined;

const provider: PaymentProvider = payfastConfigured
  ? new PayfastPaymentProvider({
      merchantId: config.PAYFAST_MERCHANT_ID!,
      merchantKey: config.PAYFAST_MERCHANT_KEY!,
      passphrase: config.PAYFAST_PASSPHRASE!,
      ...(config.PAYFAST_BASE_URL !== undefined && { baseUrl: config.PAYFAST_BASE_URL }),
    })
  : new FakePaymentProvider();

assertWorkerProductionReady(config, {
  usingFakeSender: !twilioConfigured,
  usingFakePaymentProvider: !payfastConfigured,
});

const { db, client } = createDatabase({
  url: config.DATABASE_URL,
  maxConnections: config.DATABASE_MAX_CONNECTIONS,
});

const workerId = `${process.env["HOSTNAME"] ?? "worker"}-${process.pid}`;

const reporter: ErrorReporter = config.ALERT_WEBHOOK_URL
  ? new WebhookReporter({
      url: config.ALERT_WEBHOOK_URL,
      environment: config.ENVIRONMENT,
      service: "worker",
      minimumSeverity: config.ALERT_MIN_SEVERITY,
      ...(config.RELEASE !== undefined && { release: config.RELEASE }),
      onDeliveryFailure: (error) => log.error({ error }, "failed to deliver alert"),
    })
  : new NoopReporter();

const scheduler = startScheduler(config, {
  db,
  log,
  drain: {
    sender,
    workerId,
    ...(config.WHATSAPP_DAILY_SPEND_CAP_CENTS !== undefined && {
      dailySpendCapCents: config.WHATSAPP_DAILY_SPEND_CAP_CENTS,
      onSpendCapExceeded: (context) =>
        log.warn(context, "daily WhatsApp spend cap exceeded — alerting, not blocking"),
    }),
  },
  dunning: { provider },
  reporter,
});

await registerSchedules(scheduler.queue, config);
log.info({ workerId, queue: scheduler.queue.name }, "worker started");

/**
 * Graceful shutdown.
 *
 * `scheduler.close()` waits for the in-flight job to finish, and that wait is
 * load-bearing rather than tidiness: a drain killed between the Twilio call
 * and the row update leaves a claimed row that nothing will ever reclaim (see
 * `findStalledSends`). Every job we let finish is one an operator does not
 * have to adjudicate by hand.
 */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    void scheduler
      .close()
      .then(() => client.end())
      .then(() => process.exit(0))
      .catch((error) => {
        log.error({ error }, "error during shutdown");
        process.exit(1);
      });
  });
}

import pino from "pino";
import { createDatabase } from "@locum/db";
import { FakePaymentProvider, FakeWhatsAppSender } from "@locum/core";
import { assertWorkerProductionReady, loadWorkerConfig } from "./config";
import { registerSchedules, startScheduler } from "./scheduler";

const config = loadWorkerConfig();
const log = pino({ level: config.NODE_ENV === "production" ? "info" : "debug" });

/*
 * §15 classes both of these adapters as externally blocked: the real ones need
 * an approved Meta sender (§11.1) and a Payfast merchant account, neither of
 * which can be created from here. The fakes are what runs locally, and
 * assertWorkerProductionReady is told so explicitly — a worker running the
 * fake sender marks every message `sent` and reports healthy while nothing
 * arrives, which is the worst failure shape this service has.
 *
 * When the real adapters land, construct them here and drop the flags.
 */
const sender = new FakeWhatsAppSender();
const provider = new FakePaymentProvider();

assertWorkerProductionReady(config, {
  usingFakeSender: true,
  usingFakePaymentProvider: true,
});

const { db, client } = createDatabase({
  url: config.DATABASE_URL,
  maxConnections: config.DATABASE_MAX_CONNECTIONS,
});

const workerId = `${process.env["HOSTNAME"] ?? "worker"}-${process.pid}`;

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

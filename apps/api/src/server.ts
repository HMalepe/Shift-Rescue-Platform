import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import formBody from "@fastify/formbody";
import { sql } from "drizzle-orm";
import { createDatabase, type Database, type SqlClient } from "@locum/db";
import {
  FakeWhatsAppSender,
  InMemoryDocumentStorage,
  StubDocumentScanner,
  type DocumentScanner,
  type DocumentStorage,
  type WhatsAppSender,
} from "@locum/core";
import {
  DrillError,
  DrillGate,
  NoopReporter,
  WebhookReporter,
  classify,
  DRILL_PATH,
  type ErrorReporter,
} from "@locum/observability";
import { registerTwilioStatusWebhook } from "./twilio/status-webhook";
import { registerPayfastItnWebhook } from "./payfast/itn-webhook";
import { registerAuthRoutes } from "./routes/auth";
import { registerDocumentRoutes } from "./routes/documents";
import {
  fastifyTRPCPlugin,
  type CreateFastifyContextOptions,
} from "@trpc/server/adapters/fastify";
import { appRouter } from "./trpc/router";
import { createContext } from "./trpc/context";
import type { Config } from "./config";

export interface BuiltServer {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly client: SqlClient;
  readonly reporter: ErrorReporter;
}

export interface ServerDeps {
  /**
   * Overridable so tests and local development can run without S3 or a virus
   * daemon. Production must inject real implementations — see
   * `assertProductionReady`, which refuses to boot with the stubs.
   */
  readonly documentStorage?: DocumentStorage;
  readonly documentScanner?: DocumentScanner;
  /** §12.3 — the fan-out sends inline; production must not get the fake. */
  readonly whatsappSender?: WhatsAppSender;
  /** Injected by tests so alerting can be asserted without a receiver. */
  readonly reporter?: ErrorReporter;
  /** Overridable so tests can stub Payfast's postback-validate call. */
  readonly payfastFetchImpl?: typeof fetch;
}

export async function buildServer(
  config: Config,
  deps: ServerDeps = {},
): Promise<BuiltServer> {
  const documentStorage = deps.documentStorage ?? new InMemoryDocumentStorage();
  const documentScanner = deps.documentScanner ?? new StubDocumentScanner();
  const whatsappSender = deps.whatsappSender ?? new FakeWhatsAppSender();


  const { db, client } = createDatabase({
    url: config.DATABASE_URL,
    maxConnections: config.DATABASE_MAX_CONNECTIONS,
  });

  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: "info" },
    // Trust the proxy so rate limiting keys on the real client IP rather than
    // the load balancer's — otherwise every request shares one bucket and the
    // §12.1 limit protects nothing.
    trustProxy: true,
    // Twilio signs the exact bytes it sent; a body larger than this is not a
    // legitimate status callback.
    bodyLimit: 1_048_576,
  });

  const reporter: ErrorReporter =
    deps.reporter ??
    (config.ALERT_WEBHOOK_URL
      ? new WebhookReporter({
          url: config.ALERT_WEBHOOK_URL,
          environment: config.ENVIRONMENT,
          service: "api",
          minimumSeverity: config.ALERT_MIN_SEVERITY,
          ...(config.RELEASE !== undefined && { release: config.RELEASE }),
          onDeliveryFailure: (error) =>
            // The alerter failing is itself worth a log line. It cannot be
            // alerted on, for obvious reasons.
            app.log.error({ err: error }, "failed to deliver alert"),
        })
      : new NoopReporter());

  /*
   * Twilio posts `application/x-www-form-urlencoded`, which Fastify does not
   * parse out of the box — without this every webhook is answered 415 and
   * Twilio retries it forever.
   */
  await app.register(formBody);

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // §12.1: rate limiting exists to blunt credential stuffing and scraping of
    // locum personal data. Webhooks are exempted — Twilio bursts legitimately
    // during a backlog drain (§11.6) and is already authenticated by signature.
    allowList: (request) => request.url.startsWith("/webhooks/"),
  });

  /**
   * §12.2 — uptime and latency monitoring hangs off this.
   *
   * Deliberately touches the database. A health check that only proves the
   * process is alive will report green while every booking confirmation is
   * failing on a dead connection pool, which is precisely the outage that
   * stops a pharmacy trading.
   */
  app.get("/health", async (_request, reply) => {
    const startedAt = Date.now();
    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      reply.code(503);
      return {
        status: "unhealthy",
        database: "unreachable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      status: "healthy",
      environment: config.ENVIRONMENT,
      databaseLatencyMs: Date.now() - startedAt,
    };
  });

  /** Liveness only — for the orchestrator's restart decision, not for alerting. */
  app.get("/health/live", async () => ({ status: "alive" }));

  registerAuthRoutes(app, { db, config });
  registerDocumentRoutes(app, { db, config, documentStorage });
  /*
   * §0.1 — the deliberately broken endpoint.
   *
   * Registered unconditionally and gated at request time by DrillGate, rather
   * than conditionally registered. The difference matters: a route that only
   * exists when a flag is set cannot be tested in the configuration that
   * production actually runs, and "is it really off?" is precisely the
   * question worth having a test for.
   */
  const drillGate = new DrillGate({
    enabled: config.DRILL_ENABLED,
    secret: config.DRILL_SECRET,
  });

  app.post(DRILL_PATH, async (request, reply) => {
    const presented = request.headers["x-drill-secret"];
    const outcome = drillGate.check(
      typeof presented === "string" ? presented : undefined,
    );

    if (!outcome.allowed) {
      return reply.code(outcome.status).send({ error: outcome.reason });
    }

    const error = new DrillError(
      `fired from ${config.ENVIRONMENT} at ${new Date().toISOString()}`,
    );

    app.log.error({ err: error }, "alerting drill fired");
    reporter.report({
      error,
      operation: `POST ${DRILL_PATH}`,
      severity: classify(error),
      context: { environment: config.ENVIRONMENT, deliberate: true },
    });

    /*
     * Flushed before replying. Everywhere else delivery is fire-and-forget so
     * a user never waits on PagerDuty — but the entire purpose of this
     * endpoint is to answer "did the alert go out?", and a 200 sent before the
     * POST completed would answer it with a guess.
     */
    await reporter.flush(3_000);

    return reply.code(500).send({
      error: "drill_fired",
      message: "Deliberate failure. An alert should have been delivered.",
    });
  });

  registerTwilioStatusWebhook(app, { db, config });
  registerPayfastItnWebhook(app, {
    db,
    config,
    ...(deps.payfastFetchImpl !== undefined && { fetchImpl: deps.payfastFetchImpl }),
  });

  /*
   * tRPC. Mounted last so the explicit REST routes above (auth, webhooks) keep
   * their own error shapes — Twilio and Payfast expect plain HTTP status
   * codes, not a tRPC envelope.
   */
  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: CreateFastifyContextOptions) =>
        createContext(
          { db, config, documentStorage, documentScanner, whatsappSender },
          req,
        ),
      onError({ error, path }: { error: Error; path?: string | undefined }) {
        /*
         * Every tRPC failure is logged; only some are alerted on. `classify`
         * owns that decision (§0.1) — routing all of them to a pager would
         * mean paging on every 403 and 409 the API correctly returns, and a
         * pager that fires on correct behaviour is a pager nobody reads.
         */
        const severity = classify(error);
        app.log.error({ err: error, path, severity }, "tRPC handler error");
        if (severity !== "routine") {
          reporter.report({
            error,
            operation: `trpc.${path ?? "unknown"}`,
            severity,
          });
        }
      },
    },
  });

  return { app, db, client, reporter };
}

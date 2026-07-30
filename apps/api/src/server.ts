import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import formBody from "@fastify/formbody";
import { sql } from "drizzle-orm";
import { createDatabase, type Database, type SqlClient } from "@locum/db";
import { registerTwilioStatusWebhook } from "./twilio/status-webhook";
import { registerAuthRoutes } from "./routes/auth";
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
}

export async function buildServer(config: Config): Promise<BuiltServer> {
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
  registerTwilioStatusWebhook(app, { db, config });

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
        createContext({ db, config }, req),
      onError({ error, path }: { error: Error; path?: string | undefined }) {
        app.log.error({ err: error, path }, "tRPC handler error");
      },
    },
  });

  return { app, db, client };
}

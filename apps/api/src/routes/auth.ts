import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@locum/db";
import {
  DEFAULT_AUTH_CONFIG,
  isDomainError,
  login,
  logout,
  refresh,
  type AuthConfig,
} from "@locum/core";
import type { Config } from "../config";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

/**
 * Maps domain errors to HTTP.
 *
 * The mapping is deliberately lossy on the way out: INVALID_CREDENTIALS and
 * the various MFA failures all carry their own code for the client to branch
 * on, but nothing here reveals whether an account exists.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_CREDENTIALS: 401,
  ACCOUNT_DISABLED: 403,
  TOO_MANY_ATTEMPTS: 429,
  MFA_REQUIRED: 401,
  MFA_INVALID: 401,
  MFA_ENROLMENT_REQUIRED: 403,
  INVALID_REFRESH_TOKEN: 401,
  REFRESH_TOKEN_REUSED: 401,
  SESSION_INVALIDATED: 401,
};

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { readonly db: Database; readonly config: Config },
): void {
  const { db, config } = deps;

  const authConfig: AuthConfig = {
    ...DEFAULT_AUTH_CONFIG,
    secret: config.AUTH_SECRET,
  };

  /*
   * §12.1 — "rate limiting on login/signup endpoints to prevent credential
   * stuffing".
   *
   * This is a SECOND, much tighter limit layered under the global one. The
   * global limit exists to keep the service up; this one exists to make
   * guessing passwords impractical, and those need very different numbers —
   * 100 requests/minute is fine for browsing and absurd for login attempts.
   *
   * It complements rather than replaces the per-identifier lockout in
   * packages/core: this bounds one IP hammering many accounts, the lockout
   * bounds many IPs hammering one account. Credential stuffing does both.
   */
  app.register(async (scoped) => {
    await scoped.register(import("@fastify/rate-limit"), {
      max: config.LOGIN_RATE_LIMIT_MAX,
      timeWindow: config.LOGIN_RATE_LIMIT_WINDOW_MS,
      keyGenerator: (request) => request.ip,
    });

    scoped.post("/auth/login", async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request" });
      }

      try {
        const tokens = await login(db, authConfig, {
          email: parsed.data.email,
          password: parsed.data.password,
          ...(parsed.data.totpCode !== undefined && { totpCode: parsed.data.totpCode }),
          ...(request.ip !== undefined && { ipAddress: request.ip }),
          ...(typeof request.headers["user-agent"] === "string" && {
            userAgent: request.headers["user-agent"],
          }),
        });
        return reply.code(200).send(tokens);
      } catch (error) {
        return sendDomainError(reply, error, request.log);
      }
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request" });
    }

    try {
      const tokens = await refresh(db, authConfig, parsed.data.refreshToken, {
        ...(request.ip !== undefined && { ipAddress: request.ip }),
        ...(typeof request.headers["user-agent"] === "string" && {
          userAgent: request.headers["user-agent"],
        }),
      });
      return reply.code(200).send(tokens);
    } catch (error) {
      return sendDomainError(reply, error, request.log);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request" });
    }
    await logout(db, parsed.data.refreshToken);
    // 204 regardless of whether the token was live: logout must be idempotent,
    // and reporting "that token was already dead" is an oracle.
    return reply.code(204).send();
  });
}

function sendDomainError(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  error: unknown,
  log: { error: (o: unknown, m: string) => void },
) {
  if (isDomainError(error)) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  log.error({ error }, "unexpected auth error");
  // Never leak an internal error body from an auth endpoint.
  return reply.code(500).send({ error: "internal error" });
}

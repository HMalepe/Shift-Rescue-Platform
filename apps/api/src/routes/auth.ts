import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "@locum/db";
import {
  DEFAULT_AUTH_CONFIG,
  findPharmacyArea,
  isDomainError,
  login,
  logout,
  refresh,
  register,
  adminAccountExists,
  bootstrapFirstAdmin,
  setAdminPassword,
  type AuthConfig,
} from "@locum/core";
import type { Config } from "../config";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

const registerCommon = {
  email: z.string().trim().email(),
  password: z.string().min(1, "Enter a password").max(200),
  fullName: z.string().trim().min(2).max(200),
};

const bootstrapAdminSchema = z.object(registerCommon);

const registerSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("locum"),
    ...registerCommon,
    sapcNumber: z.string().trim().min(4, "Enter your SAPC registration number").max(32),
  }),
  z.object({
    role: z.literal("manager"),
    ...registerCommon,
    pharmacyName: z.string().trim().min(2).max(200),
    addressLine: z.string().trim().min(3).max(500),
    /** One of `PHARMACY_AREAS` — see that module for why this isn't a free-text
     *  coordinate pair. */
    area: z.string().trim().min(1),
    sapcPharmacyNumber: z
      .string()
      .trim()
      .min(4, "Enter the pharmacy's SAPC registration number")
      .max(32),
  }),
]);

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
  EMAIL_TAKEN: 409,
  SAPC_NUMBER_TAKEN: 409,
  ADMIN_EXISTS: 409,
  ADMIN_NOT_FOUND: 404,
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

    /*
     * Self-service signup. Shares the login route's rate limiter rather than
     * getting its own — the risk this guards against (an IP mass-creating
     * accounts) is the same shape as credential stuffing, just aimed at
     * account creation instead of an existing password.
     *
     * Registering does not require a second sign-in: it returns a token pair
     * immediately, the same shape `/auth/login` does, so the frontend can
     * treat "just registered" and "just signed in" identically. Neither role
     * this accepts needs MFA (only admin does, and there is no self-service
     * path to admin), so issuing tokens straight from `register()`'s freshly
     * created account is safe.
     */
    scoped.post("/auth/register", async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "invalid request";
        return reply.code(400).send({ error: message });
      }

      const input = parsed.data;

      try {
        if (input.role === "manager") {
          const area = findPharmacyArea(input.area);
          if (!area) {
            return reply.code(400).send({ error: "Select a valid area" });
          }

          await register(db, {
            role: "manager",
            email: input.email,
            password: input.password,
            fullName: input.fullName,
            pharmacy: {
              name: input.pharmacyName,
              addressLine: input.addressLine,
              city: area.city,
              sapcPharmacyNumber: input.sapcPharmacyNumber,
              location: { lng: area.lng, lat: area.lat },
            },
          });
        } else {
          await register(db, {
            role: "locum",
            email: input.email,
            password: input.password,
            fullName: input.fullName,
            sapcNumber: input.sapcNumber,
          });
        }

        const tokens = await login(db, authConfig, {
          email: input.email,
          password: input.password,
          ...(request.ip !== undefined && { ipAddress: request.ip }),
          ...(typeof request.headers["user-agent"] === "string" && {
            userAgent: request.headers["user-agent"],
          }),
        });
        return reply.code(201).send(tokens);
      } catch (error) {
        return sendDomainError(reply, error, request.log);
      }
    });

    scoped.post("/auth/bootstrap-admin", async (request, reply) => {
      const parsed = bootstrapAdminSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "invalid request";
        return reply.code(400).send({ error: message });
      }

      try {
        const created = await bootstrapFirstAdmin(db, {
          email: parsed.data.email,
          password: parsed.data.password,
          fullName: parsed.data.fullName,
        });
        return reply.code(201).send({
          email: created.email,
        });
      } catch (error) {
        return sendDomainError(reply, error, request.log);
      }
    });

    scoped.post("/auth/sync-admin-password", async (request, reply) => {
      const expected = config.ADMIN_SYNC_SECRET;
      const provided = request.headers["x-admin-sync-secret"];
      if (
        expected === undefined ||
        typeof provided !== "string" ||
        !secretsMatch(expected, provided)
      ) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const parsed = z
        .object({
          email: z.string().trim().email(),
          password: z.string().min(1).max(200),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request" });
      }

      try {
        const updated = await setAdminPassword(db, parsed.data);
        return reply.code(200).send({ email: updated.email });
      } catch (error) {
        return sendDomainError(reply, error, request.log);
      }
    });
  });

  app.get("/auth/setup-status", async (_request, reply) => {
    const available = !(await adminAccountExists(db));
    return reply.code(200).send({ available });
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

function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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

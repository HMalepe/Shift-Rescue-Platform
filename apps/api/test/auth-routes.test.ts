import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { hashPassword } from "@locum/core";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: security.auth_rate_limit
 *
 * §12.1 — "rate limiting on login/signup endpoints to prevent credential
 * stuffing". The per-identifier lockout is tested in packages/core; this
 * covers the per-IP limit, which is the half that bounds one attacker
 * hammering *many* accounts.
 */

const LOGIN_LIMIT = 5;
let server: BuiltServer;
const createdUserIds: string[] = [];

beforeAll(async () => {
  server = await buildServer(
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
      // Set so the webhook's signature check is ACTIVE. Without a token the
      // check is skipped, which is intended for local development and blocked
      // in production by assertProductionReady — but it would make the
      // "webhook is exempt from the login limit" assertion below vacuous.
      TWILIO_AUTH_TOKEN: "test_twilio_token",
      LOGIN_RATE_LIMIT_MAX: String(LOGIN_LIMIT),
      LOGIN_RATE_LIMIT_WINDOW_MS: "60000",
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
    }),
  );
  await server.app.ready();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, createdUserIds));
    await server.db.delete(s.users).where(inArray(s.users.id, createdUserIds));
  }
  await server.app.close();
  await server.client.end();
});

async function makeUser(password: string) {
  const email = `route-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await server.db
    .insert(s.users)
    .values({
      role: "manager",
      email,
      fullName: "Route Test",
      passwordHash: await hashPassword(password),
    })
    .returning({ id: s.users.id });
  createdUserIds.push(user!.id);
  return { id: user!.id, email };
}

describe("GATE security.auth_rate_limit", () => {
  it("logs in and refreshes over HTTP", async () => {
    const user = await makeUser("s3cure-password!");

    const loginResponse = await server.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: "s3cure-password!" },
    });

    expect(loginResponse.statusCode).toBe(200);
    const tokens = loginResponse.json();
    expect(tokens.accessToken).toBeTypeOf("string");

    const refreshResponse = await server.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json().refreshToken).not.toBe(tokens.refreshToken);
  });

  it("returns 401 without revealing whether the account exists", async () => {
    const user = await makeUser("s3cure-password!");

    const wrongPassword = await server.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: "wrong" },
      headers: { "x-forwarded-for": "10.1.1.1" },
    });
    const noSuchUser = await server.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@test.invalid", password: "wrong" },
      headers: { "x-forwarded-for": "10.1.1.2" },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    // Byte-identical bodies: no enumeration oracle.
    expect(wrongPassword.body).toBe(noSuchUser.body);
  });

  it("rate limits repeated login attempts from one IP", async () => {
    const ip = "203.0.113.99";
    const statuses: number[] = [];

    for (let i = 0; i < LOGIN_LIMIT + 3; i += 1) {
      const response = await server.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: `victim${i}@test.invalid`, password: "guess" },
        headers: { "x-forwarded-for": ip },
      });
      statuses.push(response.statusCode);
    }

    // Note the emails differ on every attempt — this is stuffing across many
    // accounts, which the per-identifier lockout cannot see. Only the per-IP
    // limit stops it.
    expect(statuses.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it("does not rate limit the webhook path under the login limit", async () => {
    // Twilio bursts legitimately when a quiet-hours backlog drains (§11.6);
    // applying the login limit there would drop real delivery receipts.
    const response = await server.app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SMratelimit&MessageStatus=delivered",
    });
    // 403 for the missing signature, NOT 429.
    expect(response.statusCode).toBe(403);
  });

  it("logout is idempotent", async () => {
    const user = await makeUser("s3cure-password!");
    const login = await server.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: "s3cure-password!" },
    });
    const { refreshToken } = login.json();

    const first = await server.app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken },
    });
    const second = await server.app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken },
    });

    // Both 204: reporting "already logged out" would be an oracle.
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
  });
});

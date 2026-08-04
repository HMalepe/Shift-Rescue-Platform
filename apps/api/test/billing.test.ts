import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { hashPassword } from "@locum/core";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: billing.subscribe (tRPC mutation)
 *
 * Exercises the manager-authorization boundary and the find-or-create
 * behaviour of `beginSubscribe` through the actual HTTP/tRPC path, rather
 * than calling the core function directly — the interesting failure mode is
 * a manager reaching another pharmacy's `custom_str1`, and that boundary
 * lives in this router, not in core.
 */

const JOHANNESBURG = { lng: 28.0473, lat: -26.2041 } as const;
const PASSWORD = "s3cure-password!";
const DASHBOARD_BASE_URL = "https://app.example.com";

let server: BuiltServer;
const userIds: string[] = [];
const pharmacyIds: string[] = [];

interface Actor {
  readonly id: string;
  readonly email: string;
  accessToken: string;
}

beforeAll(async () => {
  server = await buildServer(
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
      PAYFAST_MERCHANT_ID: "10000100",
      PAYFAST_MERCHANT_KEY: "46f0cd694581a",
      PAYFAST_PASSPHRASE: "jt7NOE43FZPn",
      DASHBOARD_BASE_URL,
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
    }),
  );
  await server.app.ready();
});

afterAll(async () => {
  if (pharmacyIds.length > 0) {
    const subs = await server.db
      .select({ id: s.subscriptions.id })
      .from(s.subscriptions)
      .where(inArray(s.subscriptions.pharmacyId, pharmacyIds));
    const subIds = subs.map((r) => r.id);
    if (subIds.length > 0) {
      await server.db
        .delete(s.subscriptionCharges)
        .where(inArray(s.subscriptionCharges.subscriptionId, subIds));
      await server.db.delete(s.subscriptions).where(inArray(s.subscriptions.id, subIds));
    }
    await server.db
      .delete(s.pharmacyMembers)
      .where(inArray(s.pharmacyMembers.pharmacyId, pharmacyIds));
    await server.db.delete(s.pharmacies).where(inArray(s.pharmacies.id, pharmacyIds));
  }
  if (userIds.length > 0) {
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, userIds));
    await server.db.delete(s.users).where(inArray(s.users.id, userIds));
  }
  await server.app.close();
  await server.client.end();
});

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let actorCounter = 0;
const nextActorIp = () => `198.51.100.${(actorCounter += 1) % 250}`;

async function makeActor(role: "manager" | "locum"): Promise<Actor> {
  const email = `billing-${role}-${unique()}@test.invalid`;
  const [user] = await server.db
    .insert(s.users)
    .values({
      role,
      email,
      fullName: `${role} tester`,
      passwordHash: await hashPassword(PASSWORD),
    })
    .returning({ id: s.users.id });
  userIds.push(user!.id);

  const response = await server.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD },
    headers: { "x-forwarded-for": nextActorIp() },
  });

  if (response.statusCode !== 200) {
    throw new Error(`fixture login failed (${response.statusCode}): ${response.body}`);
  }

  return { id: user!.id, email, accessToken: response.json().accessToken };
}

async function makePharmacy(managerId: string) {
  const [pharmacy] = await server.db
    .insert(s.pharmacies)
    .values({
      name: `Billing Pharmacy ${unique()}`,
      addressLine: "1 Test Road",
      city: "Johannesburg",
      location: JOHANNESBURG,
    })
    .returning({ id: s.pharmacies.id });
  pharmacyIds.push(pharmacy!.id);

  await server.db.insert(s.pharmacyMembers).values({
    pharmacyId: pharmacy!.id,
    userId: managerId,
    isPrimary: true,
  });

  return pharmacy!.id;
}

let callerSeq = 0;
const addressFor = new Map<string, string>();
function ipFor(token: string | undefined): string {
  const key = token ?? "anonymous";
  if (!addressFor.has(key)) {
    callerSeq += 1;
    addressFor.set(key, `10.${(callerSeq >> 8) & 255}.${callerSeq & 255}.1`);
  }
  return addressFor.get(key)!;
}

async function call(
  path: string,
  input: Record<string, unknown>,
  token?: string,
): Promise<LightMyRequestResponse> {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return await server.app.inject({
    method: "POST",
    url: `/trpc/${path}`,
    payload: input,
    headers,
    remoteAddress: ipFor(token),
  });
}

describe("GATE billing.subscribe — tRPC", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await call("billing.subscribe", {
      pharmacyId: crypto.randomUUID(),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a locum", async () => {
    const locum = await makeActor("locum");
    const response = await call(
      "billing.subscribe",
      { pharmacyId: crypto.randomUUID() },
      locum.accessToken,
    );
    expect(response.statusCode).toBe(403);
  });

  it("refuses a manager subscribing another pharmacy", async () => {
    const owner = await makeActor("manager");
    const outsider = await makeActor("manager");
    const pharmacyId = await makePharmacy(owner.id);

    const response = await call("billing.subscribe", { pharmacyId }, outsider.accessToken);
    expect(response.statusCode).toBe(403);
  });

  it("returns a signed redirect pointing the browser at the dashboard and Payfast at this API", async () => {
    const manager = await makeActor("manager");
    const pharmacyId = await makePharmacy(manager.id);

    const response = await call("billing.subscribe", { pharmacyId }, manager.accessToken);
    expect(response.statusCode).toBe(200);

    const result = response.json().result.data as {
      url: string;
      fields: Array<[string, string]>;
    };
    const fields = Object.fromEntries(result.fields);

    expect(fields["return_url"]).toBe(`${DASHBOARD_BASE_URL}/billing/return`);
    expect(fields["cancel_url"]).toBe(`${DASHBOARD_BASE_URL}/billing/cancel`);
    expect(fields["notify_url"]).toMatch(/\/webhooks\/payfast\/itn$/);
    expect(fields["custom_str1"]).toBeTruthy();
    expect(fields["signature"]).toMatch(/^[0-9a-f]{32}$/);

    const [row] = await server.db
      .select({ status: s.subscriptions.status })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.pharmacyId, pharmacyId));
    expect(row?.status).toBe("trialing");
  });

  it("refuses to re-subscribe a pharmacy that already has an active, tokenized subscription", async () => {
    const manager = await makeActor("manager");
    const pharmacyId = await makePharmacy(manager.id);

    await server.db.insert(s.subscriptions).values({
      pharmacyId,
      status: "active",
      provider: "payfast",
      providerRef: "pf_already_tokenized",
      monthlyCents: 89_900,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });

    const response = await call("billing.subscribe", { pharmacyId }, manager.accessToken);
    expect(response.statusCode).toBe(409);
  });
});

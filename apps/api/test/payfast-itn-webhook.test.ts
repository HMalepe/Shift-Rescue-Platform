import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: security.webhook_signature (Payfast ITN) + billing.subscribe activation
 *
 * §2/§15: G -> X. The signing/verification algorithm is Payfast's documented
 * one (PHP `urlencode` semantics, MD5 over fields as posted, passphrase
 * appended last) — there is no live sandbox to confirm the exact field set
 * Payfast sends for a real tokenize ITN against yet.
 *
 * The signer here is a deliberately independent re-implementation from the
 * one in packages/core/src/billing/subscribe.ts, not an import of it — a test
 * that builds its fixture with the same function it verifies against would
 * only prove the function agrees with itself.
 */

const PASSPHRASE = "jt7NOE43FZPn";
const WEBHOOK_PATH = "/webhooks/payfast/itn";

function payfastEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
}

function signFields(fields: ReadonlyArray<readonly [string, string]>): string {
  const base = fields
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${payfastEncode(v)}`)
    .join("&");
  return createHash("md5")
    .update(`${base}&passphrase=${payfastEncode(PASSPHRASE)}`)
    .digest("hex");
}

function itnBody(fields: Record<string, string>): string {
  const entries = Object.entries(fields);
  const signature = signFields(entries);
  return new URLSearchParams({ ...fields, signature }).toString();
}

let server: BuiltServer;
const pharmacyIds: string[] = [];

async function makeSubscription() {
  const [pharmacy] = await server.db
    .insert(s.pharmacies)
    .values({
      name: `ITN Pharmacy ${Date.now()}${Math.random()}`,
      addressLine: "1 Road",
      city: "Johannesburg",
      location: { lng: 28.0473, lat: -26.2041 },
    })
    .returning({ id: s.pharmacies.id });
  pharmacyIds.push(pharmacy!.id);

  const [subscription] = await server.db
    .insert(s.subscriptions)
    .values({
      pharmacyId: pharmacy!.id,
      status: "trialing",
      provider: "payfast",
      monthlyCents: 89_900,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    })
    .returning({ id: s.subscriptions.id });

  return subscription!.id;
}

beforeAll(async () => {
  server = await buildServer(
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      PAYFAST_MERCHANT_ID: "10000100",
      PAYFAST_MERCHANT_KEY: "46f0cd694581a",
      PAYFAST_PASSPHRASE: PASSPHRASE,
      AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
    }),
    {
      // Stub out the real network call to Payfast's postback-validate
      // endpoint — there is no live sandbox to call in CI, and the signature
      // check ahead of it is what these tests are actually exercising.
      payfastFetchImpl: (async () => new Response("VALID")) as unknown as typeof fetch,
    },
  );
  await server.app.ready();
});

afterAll(async () => {
  const ids = pharmacyIds.splice(0);
  if (ids.length > 0) {
    const subs = await server.db
      .select({ id: s.subscriptions.id })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.pharmacyId, ids[0]!));
    for (const sub of subs) {
      await server.db.delete(s.subscriptionCharges).where(eq(s.subscriptionCharges.subscriptionId, sub.id));
    }
    await server.db.delete(s.subscriptions).where(eq(s.subscriptions.pharmacyId, ids[0]!));
    await server.db.delete(s.pharmacies).where(eq(s.pharmacies.id, ids[0]!));
  }
  await server.app.close();
  await server.client.end();
});

describe("GATE security.webhook_signature — Payfast ITN", () => {
  it("rejects a request with no signature field", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ pf_payment_id: "1", custom_str1: "x" }).toString(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a tampered amount even with an otherwise-valid signature shape", async () => {
    const subscriptionId = await makeSubscription();
    const signed = itnBody({
      m_payment_id: `sub_init_${subscriptionId}`,
      pf_payment_id: "pf_9999",
      payment_status: "COMPLETE",
      amount_gross: "899.00",
      custom_str1: subscriptionId,
    });
    // Tamper with the amount after signing.
    const tampered = signed.replace("899.00", "1.00");

    const response = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: tampered,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GATE billing.subscribe — ITN activation", () => {
  it("activates a subscription on a correctly signed COMPLETE ITN", async () => {
    const subscriptionId = await makeSubscription();
    const payload = itnBody({
      m_payment_id: `sub_init_${subscriptionId}`,
      pf_payment_id: `pf_${Date.now()}`,
      payment_status: "COMPLETE",
      amount_gross: "899.00",
      custom_str1: subscriptionId,
      token: "pf_mandate_xyz",
    });

    const response = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, replayed: false });

    const [row] = await server.db
      .select({ status: s.subscriptions.status, providerRef: s.subscriptions.providerRef })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, subscriptionId));
    expect(row?.status).toBe("active");
    expect(row?.providerRef).toBe("pf_mandate_xyz");
  });

  it("is idempotent under Payfast's at-least-once redelivery", async () => {
    const subscriptionId = await makeSubscription();
    const pfPaymentId = `pf_dup_${Date.now()}`;
    const payload = itnBody({
      m_payment_id: `sub_init_${subscriptionId}`,
      pf_payment_id: pfPaymentId,
      payment_status: "COMPLETE",
      amount_gross: "899.00",
      custom_str1: subscriptionId,
      token: "pf_mandate_dup",
    });

    const first = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload,
    });
    const second = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ replayed: true });

    const charges = await server.db
      .select({ id: s.subscriptionCharges.id })
      .from(s.subscriptionCharges)
      .where(eq(s.subscriptionCharges.subscriptionId, subscriptionId));
    expect(charges).toHaveLength(1);
  });

  it("acknowledges but ignores a non-COMPLETE payment status", async () => {
    const subscriptionId = await makeSubscription();
    const payload = itnBody({
      m_payment_id: `sub_init_${subscriptionId}`,
      pf_payment_id: `pf_cancel_${Date.now()}`,
      payment_status: "CANCELLED",
      amount_gross: "899.00",
      custom_str1: subscriptionId,
      token: "pf_mandate_cancelled",
    });

    const response = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ignored: true });

    const [row] = await server.db
      .select({ status: s.subscriptions.status })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, subscriptionId));
    expect(row?.status).toBe("trialing");
  });
});

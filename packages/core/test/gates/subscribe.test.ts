import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  activateSubscription,
  assertNotAlreadySubscribed,
  beginSubscribe,
  buildSubscribeRedirect,
  postbackValidate,
  verifyItnSignature,
  type PayfastGatewayConfig,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: billing.subscribe
 *
 * The Payfast tokenization flow: initiating a subscribe redirect, verifying
 * an ITN's signature the way Payfast actually asks for it (signed over the
 * fields AS POSTED, not re-sorted), and activating a subscription once
 * Payfast confirms both the signature and the postback-validate step.
 *
 * §15: G -> X. Everything below is exercised against known-good/known-bad
 * fixtures and a fake fetch for the postback step — there is no live Payfast
 * sandbox to confirm the exact field list/order against yet.
 */

const GATEWAY: PayfastGatewayConfig = {
  merchantId: "10000100",
  merchantKey: "46f0cd694581a",
  passphrase: "jt7NOE43FZPn",
};

const { db, client } = connect();
const pharmacyIds: string[] = [];

const JHB = { lng: 28.0473, lat: -26.2041 };

async function makeSubscription(status: "trialing" | "active" = "trialing") {
  const [pharmacy] = await db
    .insert(s.pharmacies)
    .values({
      name: `Subscribe Pharmacy ${Date.now()}${Math.random()}`,
      addressLine: "1 Road",
      city: "Johannesburg",
      location: JHB,
    })
    .returning({ id: s.pharmacies.id });
  pharmacyIds.push(pharmacy!.id);

  const [subscription] = await db
    .insert(s.subscriptions)
    .values({
      pharmacyId: pharmacy!.id,
      status,
      provider: "payfast",
      ...(status === "active" ? { providerRef: `pf_token_${Date.now()}${Math.random()}` } : {}),
      monthlyCents: 89_900,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    })
    .returning({ id: s.subscriptions.id });

  return { pharmacyId: pharmacy!.id, subscriptionId: subscription!.id };
}

afterEach(async () => {
  const ids = pharmacyIds.splice(0);
  if (ids.length === 0) return;
  const subs = await db
    .select({ id: s.subscriptions.id })
    .from(s.subscriptions)
    .where(inArray(s.subscriptions.pharmacyId, ids));
  const subIds = subs.map((r) => r.id);
  if (subIds.length > 0) {
    await db
      .delete(s.subscriptionCharges)
      .where(inArray(s.subscriptionCharges.subscriptionId, subIds));
    await db.delete(s.subscriptions).where(inArray(s.subscriptions.id, subIds));
  }
  await db.delete(s.pharmacies).where(inArray(s.pharmacies.id, ids));
});

afterAll(async () => {
  await client.end();
});

describe("GATE billing.subscribe — redirect construction", () => {
  it("signs the fields and omits empty ones from the signature base", () => {
    const redirect = buildSubscribeRedirect(GATEWAY, {
      subscriptionId: "11111111-1111-1111-1111-111111111111",
      amountCents: 89_900,
      itemName: "Locum Planner subscription",
      returnUrl: "https://app.example.com/billing/return",
      cancelUrl: "https://app.example.com/billing/cancel",
      notifyUrl: "https://api.example.com/webhooks/payfast",
    });

    const asObject = Object.fromEntries(redirect.fields);
    expect(asObject["merchant_id"]).toBe(GATEWAY.merchantId);
    expect(asObject["amount"]).toBe("899.00");
    expect(asObject["subscription_type"]).toBe("2");
    expect(asObject["custom_str1"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(asObject["signature"]).toMatch(/^[0-9a-f]{32}$/);
    // email_address was never supplied, so it must not appear at all —
    // Payfast signs only fields that were actually sent.
    expect(asObject["email_address"]).toBeUndefined();
  });

  it("refuses to build a redirect for a non-positive amount", () => {
    expect(() =>
      buildSubscribeRedirect(GATEWAY, {
        subscriptionId: "11111111-1111-1111-1111-111111111111",
        amountCents: 0,
        itemName: "Locum Planner subscription",
        returnUrl: "https://app.example.com/billing/return",
        cancelUrl: "https://app.example.com/billing/cancel",
        notifyUrl: "https://api.example.com/webhooks/payfast",
      }),
    ).toThrow(/non-positive/);
  });
});

describe("GATE billing.subscribe — ITN signature verification", () => {
  it("accepts a signature computed the same way it signs outbound redirects", () => {
    const redirect = buildSubscribeRedirect(GATEWAY, {
      subscriptionId: "22222222-2222-2222-2222-222222222222",
      amountCents: 89_900,
      itemName: "Locum Planner subscription",
      returnUrl: "https://app.example.com/billing/return",
      cancelUrl: "https://app.example.com/billing/cancel",
      notifyUrl: "https://api.example.com/webhooks/payfast",
    });

    expect(verifyItnSignature(redirect.fields, GATEWAY.passphrase)).toBe(true);
  });

  it("rejects a tampered field", () => {
    const redirect = buildSubscribeRedirect(GATEWAY, {
      subscriptionId: "33333333-3333-3333-3333-333333333333",
      amountCents: 89_900,
      itemName: "Locum Planner subscription",
      returnUrl: "https://app.example.com/billing/return",
      cancelUrl: "https://app.example.com/billing/cancel",
      notifyUrl: "https://api.example.com/webhooks/payfast",
    });

    const tampered = redirect.fields.map(([k, v]) =>
      k === "amount" ? ([k, "1.00"] as const) : ([k, v] as const),
    );

    expect(verifyItnSignature(tampered, GATEWAY.passphrase)).toBe(false);
  });

  it("rejects when there is no signature field at all", () => {
    expect(verifyItnSignature([["merchant_id", GATEWAY.merchantId]], GATEWAY.passphrase)).toBe(
      false,
    );
  });
});

describe("GATE billing.subscribe — postback validation", () => {
  it("treats a literal VALID response as valid", async () => {
    const ok = await postbackValidate("m_payment_id=x", {
      fetchImpl: (async () => new Response("VALID")) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
  });

  it("fails closed on anything other than exactly VALID", async () => {
    const ok = await postbackValidate("m_payment_id=x", {
      fetchImpl: (async () => new Response("INVALID")) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  it("fails closed when the postback endpoint is unreachable", async () => {
    const ok = await postbackValidate("m_payment_id=x", {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });
});

describe("GATE billing.subscribe — activation", () => {
  it("tokenizes a trialing subscription and records the settled period", async () => {
    const { subscriptionId } = await makeSubscription("trialing");
    const periodStart = new Date();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000);

    const { chargeId } = await activateSubscription(db, {
      subscriptionId,
      mandateToken: "pf_mandate_abc123",
      amountCents: 89_900,
      payfastTxnRef: "pf_payment_999",
      periodStart,
      periodEnd,
    });

    expect(chargeId).toBeTruthy();

    const [row] = await db
      .select({ status: s.subscriptions.status, providerRef: s.subscriptions.providerRef })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, subscriptionId));
    expect(row?.status).toBe("active");
    expect(row?.providerRef).toBe("pf_mandate_abc123");

    const [charge] = await db
      .select({ status: s.subscriptionCharges.status, amountCents: s.subscriptionCharges.amountCents })
      .from(s.subscriptionCharges)
      .where(eq(s.subscriptionCharges.id, chargeId));
    expect(charge?.status).toBe("succeeded");
    expect(charge?.amountCents).toBe(89_900);
  });

  it("throws SUBSCRIPTION_NOT_FOUND for an unknown id", async () => {
    await expect(
      activateSubscription(db, {
        subscriptionId: "00000000-0000-0000-0000-000000000000",
        mandateToken: "pf_mandate_abc123",
        amountCents: 89_900,
        payfastTxnRef: "pf_payment_999",
        periodStart: new Date(),
        periodEnd: new Date(),
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_NOT_FOUND" });
  });
});

describe("GATE billing.subscribe — duplicate-subscribe guard", () => {
  it("allows a trialing pharmacy to subscribe", async () => {
    const { pharmacyId } = await makeSubscription("trialing");
    await expect(assertNotAlreadySubscribed(db, pharmacyId)).resolves.toBeUndefined();
  });

  it("refuses a pharmacy that already has an active, tokenized subscription", async () => {
    const { pharmacyId } = await makeSubscription("active");
    await expect(assertNotAlreadySubscribed(db, pharmacyId)).rejects.toMatchObject({
      code: "SUBSCRIPTION_ALREADY_ACTIVE",
    });
  });
});

describe("GATE billing.subscribe — beginSubscribe (find-or-create)", () => {
  it("creates a trialing subscription for a pharmacy with none yet", async () => {
    const [pharmacy] = await db
      .insert(s.pharmacies)
      .values({
        name: `Fresh Pharmacy ${Date.now()}${Math.random()}`,
        addressLine: "1 Road",
        city: "Johannesburg",
        location: JHB,
      })
      .returning({ id: s.pharmacies.id });
    pharmacyIds.push(pharmacy!.id);

    const { subscriptionId } = await beginSubscribe(db, {
      pharmacyId: pharmacy!.id,
      monthlyCents: 89_900,
    });

    const [row] = await db
      .select({ status: s.subscriptions.status, monthlyCents: s.subscriptions.monthlyCents })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, subscriptionId));
    expect(row?.status).toBe("trialing");
    expect(row?.monthlyCents).toBe(89_900);
  });

  it("returns the existing subscription id for an untokenized pharmacy, without inserting a second row", async () => {
    const { pharmacyId, subscriptionId } = await makeSubscription("trialing");

    const result = await beginSubscribe(db, { pharmacyId, monthlyCents: 89_900 });
    expect(result.subscriptionId).toBe(subscriptionId);

    const rows = await db
      .select({ id: s.subscriptions.id })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.pharmacyId, pharmacyId));
    expect(rows).toHaveLength(1);
  });

  it("refuses when the pharmacy already has an active, tokenized subscription", async () => {
    const { pharmacyId } = await makeSubscription("active");
    await expect(
      beginSubscribe(db, { pharmacyId, monthlyCents: 89_900 }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_ALREADY_ACTIVE" });
  });
});

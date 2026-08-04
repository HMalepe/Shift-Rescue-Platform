import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PayfastPaymentProvider,
  payfastEncode,
  payfastSignature,
} from "../src/index";

/**
 * GATE: billing.payfast_adapter
 *
 * §15 lists the Payfast sandbox as externally blocked, so no money moves here.
 * What is provable against a real HTTP server is the part §2's entire
 * timeout-safety design rests on: that OUR idempotency key reaches Payfast and
 * can be looked up afterwards.
 *
 * If that one field is wrong, everything still looks fine — charges succeed,
 * tests pass — right up until a response is lost. Then `lookup` finds nothing,
 * the `unknown` outcome never resolves, and the next attempt bills a pharmacy
 * that has already paid. It is the least visible and most expensive way this
 * adapter can be wrong, so it gets the most attention below.
 */

let payfast: Server;
let baseUrl = "";
let received: Array<{
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}> = [];
let respondWith: { status: number; payload: unknown } = {
  status: 200,
  payload: { status: "success", pf_payment_id: "PF-9911" },
};
let delayMs = 0;

beforeAll(async () => {
  payfast = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      const send = () => {
        res.writeHead(respondWith.status, { "content-type": "application/json" });
        res.end(JSON.stringify(respondWith.payload));
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => payfast.listen(0, "127.0.0.1", resolve));
  const address = payfast.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => payfast.close(() => resolve()));
});

function provider(overrides: Record<string, unknown> = {}) {
  received = [];
  delayMs = 0;
  respondWith = { status: 200, payload: { status: "success", pf_payment_id: "PF-9911" } };
  return new PayfastPaymentProvider({
    merchantId: "10000100",
    merchantKey: "46f0cd694581a",
    passphrase: "test-passphrase",
    baseUrl,
    ...overrides,
  });
}

describe("GATE billing.payfast_adapter — our idempotency key", () => {
  it("sends our key as m_payment_id", async () => {
    /*
     * The single most important assertion in this file. `dunning.ts` persists
     * this key in provider_ref BEFORE the charge and never overwrites it, so a
     * lost response can be reconciled. That only works if Payfast actually
     * received the key.
     */
    const outcome = await provider().charge({
      idempotencyKey: "chg_2026_08_abc123",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });

    expect(outcome.kind).toBe("succeeded");
    const body = new URLSearchParams(received[0]!.body);
    expect(body.get("m_payment_id")).toBe("chg_2026_08_abc123");
  });

  it("looks up by our key, not Payfast's", async () => {
    /*
     * When a response is lost we do not know Payfast's pf_payment_id — that
     * is the whole situation `lookup` exists for. Searching by their reference
     * would be searching by something we never received.
     */
    const p = provider();
    respondWith = { status: 200, payload: { status: "COMPLETE", pf_payment_id: "PF-1" } };

    const outcome = await p.lookup("chg_2026_08_abc123");

    expect(outcome?.kind).toBe("succeeded");
    expect(received[0]!.url).toContain("chg_2026_08_abc123");
  });

  it("sends the amount in rands, converted once", async () => {
    // Money is integer cents everywhere in this codebase; this is the single
    // point of conversion, and it happens where it can be seen.
    await provider().charge({
      idempotencyKey: "k",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });
    expect(new URLSearchParams(received[0]!.body).get("amount")).toBe("899.00");
  });
});

describe("GATE billing.payfast_adapter — the three outcomes §2 depends on", () => {
  it("reports a definite decline as declined, with its code", async () => {
    const p = provider();
    respondWith = { status: 200, payload: { status: "failed", code: "insufficient_funds" } };

    const outcome = await p.charge({
      idempotencyKey: "k",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });

    expect(outcome.kind).toBe("declined");
    if (outcome.kind !== "declined") throw new Error("unreachable");
    expect(outcome.failureCode).toBe("insufficient_funds");
    // Funds may arrive; §2's ladder should keep trying.
    expect(outcome.permanent).toBe(false);
  });

  it("marks a cancelled card permanent so the ladder stops early", async () => {
    // §2 abandons a permanently-declined charge rather than burning three
    // retries over a week on a card that no longer exists.
    const p = provider();
    respondWith = { status: 200, payload: { status: "failed", code: "card_cancelled" } };

    const outcome = await p.charge({
      idempotencyKey: "k",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });

    if (outcome.kind !== "declined") throw new Error("expected a decline");
    expect(outcome.permanent).toBe(true);
  });

  it("reports a timeout as UNKNOWN, never as a decline", async () => {
    /*
     * The distinction the whole dunning design is built on. A timeout means
     * the charge may have succeeded while the response was lost. Reporting it
     * as declined would let §2 retry, and retrying is how a pharmacy gets
     * billed twice for one month.
     */
    const p = provider({ timeoutMs: 150 });
    delayMs = 2_000;

    const outcome = await p.charge({
      idempotencyKey: "k",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });

    expect(outcome.kind).toBe("unknown");
  });

  it("reports a 5xx as unknown rather than failed", async () => {
    const p = provider();
    respondWith = { status: 503, payload: {} };

    const outcome = await p.charge({
      idempotencyKey: "k",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });
    expect(outcome.kind).toBe("unknown");
  });

  it("returns undefined from a failed lookup rather than throwing", async () => {
    /*
     * A lookup outage means "still unknown". Throwing would let §2's caller
     * treat a Payfast incident as evidence the charge did not happen — which
     * is the reasoning that produces a double charge.
     */
    const p = provider();
    respondWith = { status: 500, payload: {} };
    expect(await p.lookup("k")).toBeUndefined();
  });

  it("returns undefined for a charge Payfast has never seen", async () => {
    const p = provider();
    respondWith = { status: 404, payload: {} };
    expect(await p.lookup("never-sent")).toBeUndefined();
  });

  it("returns undefined while a charge is still pending", async () => {
    // PENDING is not an answer, and treating it as one in either direction is
    // wrong. §2 leaves the charge unresolved and asks again later.
    const p = provider();
    respondWith = { status: 200, payload: { status: "PENDING" } };
    expect(await p.lookup("k")).toBeUndefined();
  });
});

describe("GATE billing.payfast_adapter — the signature", () => {
  it("encodes the way PHP's urlencode does, not the way JS does", () => {
    /*
     * Payfast's check is a byte comparison against a PHP reference
     * implementation. Two real differences from `encodeURIComponent`, both
     * yielding a well-formed signature rejected every single time — and the
     * failure reads as bad credentials rather than bad encoding.
     *
     * Note what is NOT a difference: hex casing. `encodeURIComponent` already
     * emits uppercase. That is asserted below because the opposite is a
     * commonly repeated claim, and this test previously encoded it.
     */
    expect(payfastEncode("Locum Planner subscription")).toBe(
      "Locum+Planner+subscription",
    );
    expect(payfastEncode("a@b.co.za")).toBe("a%40b.co.za");

    // 1. space
    expect(payfastEncode("a b")).toBe("a+b");
    expect(encodeURIComponent("a b")).toBe("a%20b");

    // 2. sub-delimiters PHP escapes and JS leaves alone
    expect(payfastEncode("a!b*c")).toBe("a%21b%2Ac");
    expect(encodeURIComponent("a!b*c")).toBe("a!b*c");

    // NOT a difference: both are uppercase.
    expect(payfastEncode("ü")).toBe("%C3%BC");
    expect(encodeURIComponent("ü")).toBe("%C3%BC");
  });

  it("is stable and order-dependent", () => {
    /*
     * Order is Payfast's documented order, not alphabetical and not whatever
     * an object literal happens to iterate. Taking entries makes that explicit
     * — an object would work today and break silently on a reorder, surfacing
     * as "every payment is failing" with a clean-looking diff.
     */
    const a = payfastSignature(
      [
        ["merchant-id", "10000100"],
        ["amount", "899.00"],
      ],
      "pass",
    );
    const b = payfastSignature(
      [
        ["amount", "899.00"],
        ["merchant-id", "10000100"],
      ],
      "pass",
    );

    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("omits empty values, as Payfast requires", () => {
    const withEmpty = payfastSignature(
      [
        ["merchant-id", "10000100"],
        ["optional", ""],
      ],
      "pass",
    );
    const without = payfastSignature([["merchant-id", "10000100"]], "pass");
    expect(withEmpty).toBe(without);
  });

  it("is sent as a header on every request", async () => {
    await provider().charge({
      idempotencyKey: "k",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });
    expect(received[0]!.headers["signature"]).toMatch(/^[0-9a-f]{32}$/);
    expect(received[0]!.headers["merchant-id"]).toBe("10000100");
  });

  it("never puts the passphrase or merchant key on the wire", async () => {
    /*
     * Both are shared secrets. The passphrase belongs only inside the hash,
     * and the merchant key is not a request parameter at all — sending either
     * would leak a credential to anything logging requests, including
     * Payfast's own access logs.
     */
    await provider().charge({
      idempotencyKey: "k",
      subscriptionRef: "SUB-77",
      amountCents: 89_900,
    });

    const wire = JSON.stringify(received[0]);
    expect(wire).not.toContain("test-passphrase");
    expect(wire).not.toContain("46f0cd694581a");
  });
});

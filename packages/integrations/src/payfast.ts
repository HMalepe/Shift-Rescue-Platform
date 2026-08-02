import { createHash } from "node:crypto";
import type { ChargeOutcome, PaymentProvider } from "@locum/core";

/**
 * §2/§0.2 — the real Payfast adapter.
 *
 * Payfast is the South African gateway the spec names. This implements the
 * `PaymentProvider` port for recurring subscription charges — the only money
 * flow that exists (§10.0: the platform never touches locum wages, and there
 * is deliberately no payout method on the interface to implement).
 *
 * ## The one thing this adapter must not get wrong
 *
 * `m_payment_id` carries OUR idempotency key.
 *
 * `dunning.ts` persists that key in `provider_ref` BEFORE the charge and never
 * overwrites it, precisely so a charge whose response was lost can be
 * reconciled rather than repeated. That only works if the key actually reaches
 * Payfast — `lookup()` searches by it. Send Payfast a key it never saw, and
 * `lookup` returns nothing, the `unknown` outcome can never resolve, and the
 * next attempt charges a pharmacy that has already paid.
 *
 * The entire timeout-safety design in §2 rests on this one field, which is why
 * it is asserted directly rather than incidentally.
 *
 * ## Signature
 *
 * Payfast signs a parameter string with MD5 over `key=value` pairs joined by
 * `&`, with the passphrase appended, and it is unforgiving in two ways that
 * are invisible until every request is rejected:
 *
 *   1. **Parameter order is the order Payfast documents**, not alphabetical
 *      and not insertion order.
 *   2. **URL-encoding must match PHP's `urlencode`**, which differs from
 *      `encodeURIComponent` in two specific ways — verified rather than
 *      assumed, because the first version of this comment claimed a third
 *      difference (lowercase hex) that does not exist:
 *
 *        - a space becomes `+`, not `%20`
 *        - `!`, `'`, `(`, `)` and `*` are escaped; `encodeURIComponent`
 *          leaves them literal
 *
 *      Both produce a well-formed signature that Payfast rejects every time,
 *      and the failure looks like bad credentials rather than bad encoding.
 *
 * MD5 is Payfast's choice, not ours. It is used here only to match their
 * scheme; nothing in this codebase relies on it for security.
 */

export interface PayfastConfig {
  readonly merchantId: string;
  readonly merchantKey: string;
  /** Optional in Payfast, but required for signed API calls in practice. */
  readonly passphrase: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * URL-encodes the way PHP's `urlencode` does.
 *
 * Payfast's reference implementation is PHP and their check is a byte
 * comparison. The two real differences from `encodeURIComponent` are the space
 * (`+` rather than `%20`) and the sub-delimiters `!'()*`, which PHP escapes and
 * JavaScript does not. Hex casing is NOT one of them — `encodeURIComponent`
 * already emits uppercase, which is worth stating because it is a widely
 * repeated claim and it is false.
 */
export function payfastEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%[0-9a-f]{2}/g, (match) => match.toUpperCase());
}

/**
 * Builds the signature over an ORDERED parameter list.
 *
 * Takes entries rather than an object so the caller states the order
 * explicitly. An object would work today and silently break the day someone
 * reorders a literal or a bundler changes key iteration — a class of bug that
 * surfaces as "every payment is failing" with a clean diff.
 */
export function payfastSignature(
  entries: ReadonlyArray<readonly [string, string]>,
  passphrase: string,
): string {
  const base = entries
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${payfastEncode(value)}`)
    .join("&");

  const withPassphrase =
    passphrase === "" ? base : `${base}&passphrase=${payfastEncode(passphrase)}`;

  return createHash("md5").update(withPassphrase).digest("hex");
}

export class PayfastError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PayfastError";
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

export class PayfastPaymentProvider implements PaymentProvider {
  private readonly config: PayfastConfig;

  constructor(config: PayfastConfig) {
    this.config = config;
  }

  async charge(input: {
    idempotencyKey: string;
    subscriptionRef: string;
    amountCents: number;
  }): Promise<ChargeOutcome> {
    /*
     * Ordered exactly as Payfast documents. See the note on `payfastSignature`
     * for why this is a list and not an object.
     *
     * `amount` is sent as a decimal string with two places because Payfast
     * expects rands; the internal representation stays integer cents right up
     * to this line, so the conversion happens once, here, where it is visible.
     */
    const entries: ReadonlyArray<readonly [string, string]> = [
      ["merchant-id", this.config.merchantId],
      ["version", "v1"],
      ["timestamp", new Date().toISOString().replace(/\.\d{3}Z$/, "")],
      ["amount", (input.amountCents / 100).toFixed(2)],
      ["item_name", "Locum Planner subscription"],
      /*
       * THE load-bearing field. Our idempotency key, which `lookup` searches
       * by. See the header comment — without it the §2 reconciliation path
       * cannot exist.
       */
      ["m_payment_id", input.idempotencyKey],
    ];

    const response = await this.request(
      "POST",
      `/subscriptions/${encodeURIComponent(input.subscriptionRef)}/adhoc`,
      entries,
    );

    if (response.status === 200 && response.body?.["status"] === "success") {
      return {
        kind: "succeeded",
        providerRef: String(response.body["pf_payment_id"] ?? input.idempotencyKey),
      };
    }

    /*
     * A definite refusal. Payfast answered, no money moved, and retrying later
     * may legitimately succeed (funds arrive) or never will (card expired) —
     * which is why `permanent` is carried separately rather than inferred.
     */
    if (response.status === 200 || response.status === 400) {
      const code = String(response.body?.["code"] ?? "unknown");
      return {
        kind: "declined",
        providerRef: String(response.body?.["pf_payment_id"] ?? input.idempotencyKey),
        failureCode: code,
        permanent: PERMANENT_DECLINE_CODES.has(code),
      };
    }

    /*
     * No answer. The dangerous one, and deliberately distinct from a decline:
     * the charge may have succeeded at Payfast while the response was lost.
     * §2 treats this as `unresolved` and reconciles via `lookup` rather than
     * retrying, because retrying is how a pharmacy gets billed twice.
     */
    return {
      kind: "unknown",
      providerRef: input.idempotencyKey,
      detail: `Payfast returned ${response.status}`,
    };
  }

  async lookup(idempotencyKey: string): Promise<ChargeOutcome | undefined> {
    /*
     * Searched by OUR key, which is the whole reason `m_payment_id` carries
     * it. Payfast's own pf_payment_id is unknown to us when a response is
     * lost — that is precisely the situation this method exists for.
     */
    const entries: ReadonlyArray<readonly [string, string]> = [
      ["merchant-id", this.config.merchantId],
      ["version", "v1"],
      ["timestamp", new Date().toISOString().replace(/\.\d{3}Z$/, "")],
    ];

    const response = await this.request(
      "GET",
      `/process/query/${encodeURIComponent(idempotencyKey)}`,
      entries,
    );

    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      /*
       * Undefined, not an exception. A failed lookup means "still unknown",
       * and §2's caller must leave the charge unresolved rather than treating
       * a lookup outage as evidence the charge did not happen.
       */
      return undefined;
    }

    const status = String(response.body?.["status"] ?? "");
    if (status === "COMPLETE") {
      return {
        kind: "succeeded",
        providerRef: String(response.body?.["pf_payment_id"] ?? idempotencyKey),
      };
    }
    if (status === "FAILED") {
      const code = String(response.body?.["reason"] ?? "unknown");
      return {
        kind: "declined",
        providerRef: String(response.body?.["pf_payment_id"] ?? idempotencyKey),
        failureCode: code,
        permanent: PERMANENT_DECLINE_CODES.has(code),
      };
    }

    // PENDING or anything unrecognised: still no answer.
    return undefined;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    entries: ReadonlyArray<readonly [string, string]>,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const base = this.config.baseUrl ?? "https://api.payfast.co.za";
    const signature = payfastSignature(entries, this.config.passphrase);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);

    try {
      const headers: Record<string, string> = {
        signature,
        "merchant-id": this.config.merchantId,
        version: "v1",
        timestamp: entries.find(([k]) => k === "timestamp")?.[1] ?? "",
      };

      const response = await doFetch(`${base}${path}`, {
        method,
        headers:
          method === "POST"
            ? { ...headers, "content-type": "application/x-www-form-urlencoded" }
            : headers,
        ...(method === "POST"
          ? {
              body: new URLSearchParams(
                entries
                  .filter(([key]) => key !== "merchant-id" && key !== "version")
                  .map(([key, value]): [string, string] => [key, value]),
              ).toString(),
            }
          : {}),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      return { status: response.status, body };
    } catch (error) {
      /*
       * A timeout is reported as a status, not thrown. `charge` turns any
       * non-answer into `kind: "unknown"`, and §2 handles that correctly —
       * throwing here would surface it as a job failure and lose the
       * distinction between "declined" and "we do not know", which is the
       * distinction the whole dunning design is built on.
       */
      if (error instanceof Error && error.name === "AbortError") {
        return { status: 408, body: null };
      }
      return { status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Declines that will never succeed on retry.
 *
 * §2's ladder abandons a charge early when the decline is permanent, rather
 * than burning three retries over a week on a card that has been cancelled.
 * Conservative on purpose: a wrongly-permanent classification restricts a
 * pharmacy that would have paid.
 */
const PERMANENT_DECLINE_CODES: ReadonlySet<string> = new Set([
  "card_expired",
  "card_cancelled",
  "account_closed",
  "invalid_card",
  "do_not_honour_permanent",
]);

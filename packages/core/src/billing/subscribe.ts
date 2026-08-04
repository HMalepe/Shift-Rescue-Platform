import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { subscriptionCharges, subscriptions, type Database } from "@locum/db";
import { DomainError } from "../errors";

/**
 * §2/§0.2 — establishing the Payfast mandate `attemptCharge` needs.
 *
 * `dunning.ts` assumes `subscriptions.providerRef` already holds a Payfast
 * token it can bill against every month. Nothing created that token — this
 * file is the missing first step, and it is fundamentally different work from
 * dunning: it involves a browser, a card, and a page this codebase does not
 * control.
 *
 * ## Why this is a redirect, not an API call
 *
 * Payfast does not offer "create a recurring mandate by posting card details
 * to an endpoint" — doing that would put this codebase in PCI scope for
 * cardholder data it should never see. The standard, PCI-safe pattern is:
 * redirect the browser to Payfast's own hosted page, let Payfast capture the
 * card, and receive a token afterwards via a server-to-server notification
 * (ITN). `buildSubscribeRedirect` produces the signed fields for that
 * redirect; it does not and cannot complete the flow itself.
 *
 * ## Why the first month is charged AS the tokenizing transaction
 *
 * Payfast's tokenization product requires an actual transaction to create a
 * token — there is no "R0 verification charge" path being relied on here.
 * Charging the first month at signup is also the ordinary SaaS pattern
 * ("your subscription starts today"), so this uses the amount the manager is
 * about to owe anyway rather than inventing a separate token-creation fee.
 * `activateSubscription` records that transaction as period 1's charge,
 * already succeeded — it must NOT also be billed again by the normal dunning
 * cycle, which is why it is written directly rather than left for
 * `openPeriodCharge` to discover.
 *
 * ## What is unverified, and will stay that way without a live account
 *
 * §15 gate: G, not X. The exact field set and field ORDER Payfast's hosted
 * "onsite payment" / subscription-tokenization product expects, and the exact
 * shape of its ITN payload, are asserted here from the vendor's publicly
 * documented integration pattern — not from a live sandbox account, which
 * does not exist in this environment. `payfastSignature`'s algorithm (MD5
 * over ordered, non-empty, url-encoded key=value pairs plus a passphrase) is
 * shared across every Payfast product and IS verified — see
 * packages/integrations/src/payfast.ts and its tests. What is unverified is
 * this specific field list surviving contact with the real hosted page and
 * the real ITN. This should be the first thing exercised against a Payfast
 * sandbox account once one exists, before any real pharmacy uses it.
 */

export interface PayfastGatewayConfig {
  readonly merchantId: string;
  readonly merchantKey: string;
  readonly passphrase: string;
  /** Payfast's hosted checkout entry point. Defaults to production. */
  readonly processUrl?: string;
}

const DEFAULT_PROCESS_URL = "https://www.payfast.co.za/eng/process";

/**
 * PHP `urlencode` semantics, and the MD5-over-ordered-pairs signature.
 *
 * Deliberately re-implemented here rather than imported from
 * `@locum/integrations`, which is an application/adapter layer — this is
 * `packages/core`, framework- and vendor-package-agnostic by design (see the
 * repo-wide convention). The encoding rules themselves are Payfast's, not
 * this package's invention, and are identical to the ones already verified in
 * `packages/integrations/test/payfast.test.ts`.
 */
function payfastEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%[0-9a-f]{2}/g, (match) => match.toUpperCase());
}

function payfastSignature(
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

export interface SubscribeRedirectInput {
  /** Our subscription row id. Carried in `custom_str1` for the ITN to find it. */
  readonly subscriptionId: string;
  /** First month's amount, in cents — this transaction both tokenizes and pays it. */
  readonly amountCents: number;
  readonly itemName: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
  readonly notifyUrl: string;
  readonly payerEmail?: string;
}

export interface SubscribeRedirect {
  /** Where the browser must be sent — a real navigation, not a fetch. */
  readonly url: string;
  /** Hidden-input values for an auto-submitting POST form, in a fixed order. */
  readonly fields: ReadonlyArray<readonly [string, string]>;
}

/**
 * Builds the signed fields for Payfast's hosted tokenization page.
 *
 * `subscription_type=2` is Payfast's "tokenization" mode — store a card for
 * future ad-hoc billing that WE trigger — as distinct from `subscription_type
 * =1`, which would hand recurring billing over to Payfast's own schedule.
 * §2's dunning state machine already owns the billing schedule (retry ladder,
 * restriction, reversibility); duplicating that inside Payfast's own recurring
 * engine would create two sources of truth for whether a pharmacy has been
 * billed this month.
 */
export function buildSubscribeRedirect(
  gateway: PayfastGatewayConfig,
  input: SubscribeRedirectInput,
): SubscribeRedirect {
  if (input.amountCents <= 0) {
    throw new DomainError(
      "SUBSCRIPTION_NOT_FOUND",
      "Cannot start a subscription with a non-positive amount",
      { subscriptionId: input.subscriptionId },
    );
  }

  const entries: Array<readonly [string, string]> = [
    ["merchant_id", gateway.merchantId],
    ["merchant_key", gateway.merchantKey],
    ["return_url", input.returnUrl],
    ["cancel_url", input.cancelUrl],
    ["notify_url", input.notifyUrl],
    ...(input.payerEmail ? ([["email_address", input.payerEmail]] as const) : []),
    // OUR reference, echoed back verbatim on every ITN — the idempotency key
    // for the initiation itself, distinct from `custom_str1` below, which
    // identifies WHICH subscription this is for.
    ["m_payment_id", `sub_init_${input.subscriptionId}`],
    ["amount", (input.amountCents / 100).toFixed(2)],
    ["item_name", input.itemName],
    // The field the ITN handler actually keys its database update on.
    ["custom_str1", input.subscriptionId],
    ["subscription_type", "2"],
  ];

  const signature = payfastSignature(entries, gateway.passphrase);

  return {
    url: gateway.processUrl ?? DEFAULT_PROCESS_URL,
    fields: [...entries, ["signature", signature]],
  };
}

export interface PayfastItnPayload {
  readonly m_payment_id?: string;
  readonly pf_payment_id?: string;
  readonly payment_status?: string;
  readonly amount_gross?: string;
  readonly custom_str1?: string;
  /**
   * The reusable billing token. Payfast's own field name for this varies by
   * product generation in publicly available integration examples — some
   * document `token`, others fold it into `pf_payment_id` for tokenize-only
   * transactions. Both are read; see the comment at the call site.
   */
  readonly token?: string;
  readonly signature?: string;
}

/**
 * Verifies an ITN's signature against fields in THE ORDER PAYFAST SENT THEM.
 *
 * This is not the same operation as `buildSubscribeRedirect`'s signing, and
 * must not be. Payfast documents ITN validation as re-signing the fields as
 * received, not re-sorting them into whatever order the outbound request
 * used — so `fields` here must be the POSTED order, which is why this takes
 * an ordered array rather than accepting an object (an object's iteration
 * order is an implementation detail this must not depend on for a security
 * check).
 */
export function verifyItnSignature(
  fields: ReadonlyArray<readonly [string, string]>,
  passphrase: string,
): boolean {
  const received = fields.find(([key]) => key === "signature")?.[1];
  if (!received) return false;

  const withoutSignature = fields.filter(([key]) => key !== "signature");
  const expected = payfastSignature(withoutSignature, passphrase);

  // Same-length check before comparing so a short-circuit string compare
  // cannot leak timing information about how many leading characters matched
  // — the same reasoning as the signed-URL verifier in documents/signed-url.ts.
  if (expected.length !== received.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Payfast's second, mandatory layer of ITN validation: posting the received
 * data back to their own server and requiring the literal response `VALID`.
 *
 * This exists in Payfast's own integration guide specifically so a request
 * that merely carries a correct signature (e.g., replayed from a genuine past
 * ITN, or crafted by someone who has the passphrase through some other leak)
 * cannot be trusted on signature alone — Payfast is asked to confirm THEY
 * actually sent this. Skipping it would mean shipping a webhook that is only
 * as safe as signature verification alone, which every piece of Payfast's own
 * documentation treats as insufficient by itself.
 */
export async function postbackValidate(
  rawBody: string,
  options: { readonly host?: string; readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  const host = options.host ?? "https://www.payfast.co.za";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await doFetch(`${host}/eng/query/validate`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: rawBody,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const text = (await response.text()).trim();
    return text === "VALID";
  } catch {
    // A postback-validate outage is treated as "not valid" — fail closed.
    // The alternative (accepting on a network error) turns a Payfast blip
    // into an unauthenticated write endpoint for the duration of the blip.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Marks the subscription active and records period 1 as already settled.
 *
 * Idempotent by design: Payfast redelivers ITNs, and `withIdempotency` keyed
 * on `pf_payment_id` is what makes a redelivery a no-op rather than a second
 * activation. Re-subscribing with a NEW token (e.g. a card update) is
 * supported by overwriting `providerRef` — this is not a security check, it
 * is a data-correctness one: the ONLY thing verified before this function is
 * called is "Payfast confirms this transaction succeeded", not "no mandate
 * existed before". `billing.subscribe` is what refuses to re-run for an
 * already-active, already-tokenized subscription.
 */
export async function activateSubscription(
  db: Database,
  input: {
    readonly subscriptionId: string;
    readonly mandateToken: string;
    readonly amountCents: number;
    readonly payfastTxnRef: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly now?: () => Date;
  },
): Promise<{ chargeId: string }> {
  const now = input.now?.() ?? new Date();

  return db.transaction(async (tx) => {
    const [subscription] = await tx
      .select({ id: subscriptions.id, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);

    if (!subscription) {
      throw new DomainError("SUBSCRIPTION_NOT_FOUND", "Subscription does not exist", {
        subscriptionId: input.subscriptionId,
      });
    }

    await tx
      .update(subscriptions)
      .set({
        providerRef: input.mandateToken,
        status: "active",
        restrictedAt: null,
        currentPeriodStart: input.periodStart,
        currentPeriodEnd: input.periodEnd,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, input.subscriptionId));

    const [charge] = await tx
      .insert(subscriptionCharges)
      .values({
        subscriptionId: input.subscriptionId,
        amountCents: input.amountCents,
        status: "succeeded",
        attempt: 1,
        // OUR key, matching the convention `attemptCharge` relies on — this
        // charge did not go through `attemptCharge`, so it mints its own
        // rather than leaving the column null.
        providerRef: `sub_init_${randomUUID()}`,
        failureDetail: `settled as ${input.payfastTxnRef}`,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        settledAt: now,
      })
      .returning({ id: subscriptionCharges.id });

    return { chargeId: charge!.id };
  });
}

/**
 * The `billing.subscribe` guard: refuses to re-initiate a subscription that
 * is already active and already has a mandate. Re-subscribing to update a
 * card is a deliberately different, explicit action from this one — this
 * function is "start paying", not "change how you pay".
 */
export async function assertNotAlreadySubscribed(
  db: Database,
  pharmacyId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.pharmacyId, pharmacyId),
        eq(subscriptions.status, "active"),
        ne(subscriptions.providerRef, sql`''`),
        sql`${subscriptions.providerRef} is not null`,
      ),
    )
    .limit(1);

  if (existing) {
    throw new DomainError(
      "SUBSCRIPTION_ALREADY_ACTIVE",
      "This pharmacy already has an active subscription",
      { pharmacyId },
    );
  }
}

/**
 * Finds the pharmacy's subscription row, creating one in `trialing` if none
 * exists yet.
 *
 * Nothing in this codebase's onboarding path inserts a `subscriptions` row —
 * pharmacy accounts are provisioned outside the app (§13, Day-0 sales-led
 * onboarding), and `trialing` is already the schema default precisely so a
 * pharmacy can post shifts before any billing relationship exists. This
 * function is what the `billing.subscribe` mutation calls first: it is the
 * single place that turns "no subscription row" into "one exists" so the
 * Payfast redirect always has a `subscriptionId` to stamp into `custom_str1`.
 *
 * Refuses (via `assertNotAlreadySubscribed`'s check, inlined here) when a
 * non-cancelled subscription is already active and tokenized — see that
 * function's comment for why re-subscribing is a different action from this.
 */
export async function beginSubscribe(
  db: Database,
  input: { readonly pharmacyId: string; readonly monthlyCents: number },
): Promise<{ subscriptionId: string }> {
  const [existing] = await db
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      providerRef: subscriptions.providerRef,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.pharmacyId, input.pharmacyId),
        ne(subscriptions.status, "cancelled"),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.status === "active" && existing.providerRef) {
      throw new DomainError(
        "SUBSCRIPTION_ALREADY_ACTIVE",
        "This pharmacy already has an active subscription",
        { pharmacyId: input.pharmacyId },
      );
    }
    return { subscriptionId: existing.id };
  }

  const now = new Date();
  const [created] = await db
    .insert(subscriptions)
    .values({
      pharmacyId: input.pharmacyId,
      status: "trialing",
      provider: "payfast",
      monthlyCents: input.monthlyCents,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    })
    .returning({ id: subscriptions.id });

  return { subscriptionId: created!.id };
}

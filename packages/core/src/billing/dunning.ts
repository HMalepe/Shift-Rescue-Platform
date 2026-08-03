import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import {
  cancellationFees,
  subscriptionCharges,
  subscriptions,
  type Database,
} from "@locum/db";
import { DomainError } from "../errors";
import type { PaymentProvider } from "./ports";

/**
 * §2 — subscription dunning and collections.
 *
 * The state machine a pharmacy moves through when a card fails:
 *
 *     active ──charge fails──► past_due ──ladder exhausted──► restricted
 *        ▲                        │                              │
 *        └────────── payment succeeds at any point ──────────────┘
 *
 * `restricted` is deliberately reversible and deliberately NOT `cancelled`.
 * A card failing is almost always an expiry or a temporary shortfall, not a
 * decision to leave. A restricted pharmacy keeps all its data and can still be
 * collected from; it simply cannot post new shifts until it pays. Deleting or
 * cancelling them would punish a clerical problem with the loss of their
 * history.
 *
 * §15 classes this gate as G → X: the state machine below is fully exercised
 * against the fake provider, but closing it properly needs a Payfast sandbox
 * driven into each error state (§0.2). That remains open.
 */

/**
 * Retry ladder, in hours after the previous failure.
 *
 * Spread rather than aggressive: many South African salaries land at month
 * end, so a shortfall on the 28th is often resolved by the 1st. Retrying four
 * times in an hour would burn the attempts before the money arrives, and some
 * providers penalise repeated declines.
 */
export const RETRY_SCHEDULE_HOURS = [24, 72, 168] as const;

/** After the ladder is exhausted, the subscription is restricted. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_HOURS.length + 1;

export interface DunningDeps {
  readonly provider: PaymentProvider;
  readonly now?: () => Date;
  /** §12.2 — the on-call rotation wants to know when a pharmacy is restricted. */
  readonly onRestricted?: (context: {
    readonly subscriptionId: string;
    readonly pharmacyId: string;
  }) => void;
}

export interface ChargeAttemptResult {
  readonly chargeId: string;
  readonly outcome: "succeeded" | "retrying" | "restricted" | "unresolved";
  readonly attempt: number;
  readonly amountCents: number;
  readonly nextRetryAt: Date | null;
}

/**
 * Opens the charge for a subscription period, folding in any unbilled
 * late-cancellation fees (§9 — "R10 is added to the month's subscription").
 *
 * The fees are attached to the charge here, not at cancellation time, so a fee
 * incurred mid-period rides on the next invoice rather than triggering its own
 * tiny transaction — which would cost more in provider fees than the R10 it
 * collects.
 */
export async function openPeriodCharge(
  db: Database,
  subscriptionId: string,
): Promise<{ chargeId: string; amountCents: number; feeCount: number }> {
  return db.transaction(async (tx) => {
    const [subscription] = await tx
      .select({
        id: subscriptions.id,
        monthlyCents: subscriptions.monthlyCents,
        status: subscriptions.status,
        periodStart: subscriptions.currentPeriodStart,
        periodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);

    if (!subscription) {
      throw new DomainError("SUBSCRIPTION_NOT_FOUND", "Subscription does not exist", {
        subscriptionId,
      });
    }
    if (subscription.status === "cancelled") {
      throw new DomainError(
        "SUBSCRIPTION_CANCELLED",
        "Cannot bill a cancelled subscription",
        { subscriptionId },
      );
    }

    const unbilled = await tx
      .select({ id: cancellationFees.id, amountCents: cancellationFees.amountCents })
      .from(cancellationFees)
      .where(
        and(
          eq(cancellationFees.subscriptionId, subscriptionId),
          isNull(cancellationFees.appliedToChargeId),
          isNull(cancellationFees.waivedAt),
        ),
      );

    const feeCents = unbilled.reduce((sum, fee) => sum + fee.amountCents, 0);
    const amountCents = subscription.monthlyCents + feeCents;

    const [charge] = await tx
      .insert(subscriptionCharges)
      .values({
        subscriptionId,
        amountCents,
        status: "pending",
        attempt: 1,
        periodStart: subscription.periodStart,
        periodEnd: subscription.periodEnd,
      })
      .returning({ id: subscriptionCharges.id });

    /*
     * Fees are marked as applied in the SAME transaction that creates the
     * charge carrying them. Doing it after settlement would let two concurrent
     * billing runs each pick up the same unbilled fee and bill it twice.
     */
    if (unbilled.length > 0) {
      await tx
        .update(cancellationFees)
        .set({ appliedToChargeId: charge!.id })
        .where(
          sql`${cancellationFees.id} in ${sql.raw(
            `(${unbilled.map((f) => `'${f.id}'`).join(",")})`,
          )}`,
        );
    }

    return {
      chargeId: charge!.id,
      amountCents,
      feeCount: unbilled.length,
    };
  });
}

/**
 * Attempts to collect one charge, and advances the dunning state.
 *
 * Safe to call repeatedly: an already-settled charge is a no-op, and a charge
 * whose previous attempt returned `unknown` is reconciled against the provider
 * before any new money is moved.
 */
export async function attemptCharge(
  db: Database,
  deps: DunningDeps,
  chargeId: string,
): Promise<ChargeAttemptResult> {
  const now = deps.now?.() ?? new Date();

  const [charge] = await db
    .select({
      id: subscriptionCharges.id,
      subscriptionId: subscriptionCharges.subscriptionId,
      amountCents: subscriptionCharges.amountCents,
      status: subscriptionCharges.status,
      attempt: subscriptionCharges.attempt,
      providerRef: subscriptionCharges.providerRef,
      pharmacyId: subscriptions.pharmacyId,
      /*
       * THE fix. This used to be missing, and `subscriptionRef` below was
       * built from `charge.subscriptionId` — OUR internal row id — instead of
       * this. Against `FakePaymentProvider` that is invisible: the fake keys
       * its in-memory map by whatever string it is handed, so an internal
       * UUID works exactly as well as a real token. Against the real
       * `PayfastPaymentProvider`, which builds
       * `/subscriptions/${subscriptionRef}/adhoc`, sending our UUID means
       * Payfast is asked to charge a mandate it has never heard of — every
       * production charge would have failed, and no test caught it because
       * every test in this file runs against the fake.
       */
      mandateRef: subscriptions.providerRef,
    })
    .from(subscriptionCharges)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionCharges.subscriptionId))
    .where(eq(subscriptionCharges.id, chargeId))
    .limit(1);

  if (!charge) {
    throw new DomainError("CHARGE_NOT_FOUND", "Charge does not exist", { chargeId });
  }

  if (!charge.mandateRef) {
    /*
     * A subscription with no payment mandate on file cannot be charged —
     * there is nothing for `subscriptionRef` to name. This is not a decline
     * (the retry ladder does not apply) and not a provider outage (`lookup`
     * has nothing to look up either): it is a subscription that was created
     * before `billing.subscribe`'s Payfast tokenization step completed, or
     * one where it failed silently. Thrown rather than treated as `unknown`,
     * so it does not quietly burn an hourly retry loop against a mandate that
     * will never appear on its own — someone has to notice and re-run
     * subscribe.
     */
    throw new DomainError(
      "SUBSCRIPTION_NOT_TOKENIZED",
      "Subscription has no payment method on file",
      { subscriptionId: charge.subscriptionId },
    );
  }

  if (charge.status === "succeeded") {
    return {
      chargeId,
      outcome: "succeeded",
      attempt: charge.attempt,
      amountCents: charge.amountCents,
      nextRetryAt: null,
    };
  }

  /*
   * The idempotency key is OURS and is persisted before the provider is
   * called, so an attempt whose response is lost can be reconciled instead of
   * repeated. `provider_ref` doubles as that key; the unique index on it means
   * two concurrent billing runs cannot mint two keys for one charge.
   */
  let idempotencyKey = charge.providerRef;

  if (idempotencyKey) {
    /*
     * A key already exists, which means a previous attempt reached the
     * provider and we did not learn the outcome. Ask before charging.
     *
     * Skipping this is exactly how a pharmacy gets billed twice for one month
     * — a far worse failure than collecting a day late, because it costs
     * trust that a refund does not buy back.
     */
    const existing = await deps.provider.lookup(idempotencyKey);
    if (existing?.kind === "succeeded") {
      await markSucceeded(db, charge.id, charge.subscriptionId, existing.providerRef, now);
      return {
        chargeId,
        outcome: "succeeded",
        attempt: charge.attempt,
        amountCents: charge.amountCents,
        nextRetryAt: null,
      };
    }
  } else {
    idempotencyKey = `chg_${randomUUID()}`;
    await db
      .update(subscriptionCharges)
      .set({ providerRef: idempotencyKey })
      .where(eq(subscriptionCharges.id, charge.id));
  }

  const outcome = await deps.provider.charge({
    idempotencyKey,
    subscriptionRef: charge.mandateRef,
    amountCents: charge.amountCents,
  });

  if (outcome.kind === "succeeded") {
    await markSucceeded(db, charge.id, charge.subscriptionId, outcome.providerRef, now);
    return {
      chargeId,
      outcome: "succeeded",
      attempt: charge.attempt,
      amountCents: charge.amountCents,
      nextRetryAt: null,
    };
  }

  if (outcome.kind === "unknown") {
    /*
     * No answer. The charge is left exactly as it is — still `pending`, still
     * holding its key — so the next run reconciles rather than re-charges.
     * Crucially the attempt counter does NOT advance: a provider outage is not
     * the pharmacy failing to pay, and burning their retry ladder on our
     * vendor's downtime would restrict an account that never declined.
     */
    await db
      .update(subscriptionCharges)
      .set({
        nextRetryAt: new Date(now.getTime() + 60 * 60 * 1000),
        failureDetail: outcome.detail,
        status: "pending",
      })
      .where(eq(subscriptionCharges.id, charge.id));

    return {
      chargeId,
      outcome: "unresolved",
      attempt: charge.attempt,
      amountCents: charge.amountCents,
      nextRetryAt: new Date(now.getTime() + 60 * 60 * 1000),
    };
  }

  // A definite decline. The ladder advances.
  const nextAttempt = charge.attempt + 1;
  const ladderIndex = charge.attempt - 1;
  const hoursUntilRetry = RETRY_SCHEDULE_HOURS[ladderIndex];

  /*
   * A permanent failure (expired card, closed account) skips the remaining
   * ladder. Retrying a card that cannot work wastes days during which the
   * pharmacy is not being told to fix anything.
   */
  const exhausted = outcome.permanent || hoursUntilRetry === undefined;

  if (exhausted) {
    await db.transaction(async (tx) => {
      await tx
        .update(subscriptionCharges)
        .set({
          status: "failed",
          attempt: nextAttempt,
          nextRetryAt: null,
          failureCode: outcome.failureCode,
        })
        .where(eq(subscriptionCharges.id, charge.id));

      await tx
        .update(subscriptions)
        .set({ status: "restricted", restrictedAt: now, updatedAt: now })
        .where(eq(subscriptions.id, charge.subscriptionId));
    });

    deps.onRestricted?.({
      subscriptionId: charge.subscriptionId,
      pharmacyId: charge.pharmacyId,
    });

    return {
      chargeId,
      outcome: "restricted",
      attempt: nextAttempt,
      amountCents: charge.amountCents,
      nextRetryAt: null,
    };
  }

  const nextRetryAt = new Date(now.getTime() + hoursUntilRetry * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    await tx
      .update(subscriptionCharges)
      .set({
        status: "retrying",
        attempt: nextAttempt,
        nextRetryAt,
        failureCode: outcome.failureCode,
      })
      .where(eq(subscriptionCharges.id, charge.id));

    await tx
      .update(subscriptions)
      .set({ status: "past_due", updatedAt: now })
      .where(
        and(
          eq(subscriptions.id, charge.subscriptionId),
          // Never walk `restricted` backwards to `past_due`.
          sql`${subscriptions.status} in ('active', 'trialing', 'past_due')`,
        ),
      );
  });

  return {
    chargeId,
    outcome: "retrying",
    attempt: nextAttempt,
    amountCents: charge.amountCents,
    nextRetryAt,
  };
}

async function markSucceeded(
  db: Database,
  chargeId: string,
  subscriptionId: string,
  providerSideRef: string,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    /*
     * `provider_ref` deliberately keeps OUR idempotency key and is never
     * overwritten with the provider's own reference.
     *
     * An earlier version did overwrite it, and a test caught the consequence:
     * the key is the only handle we have for reconciling this charge, so
     * replacing it means a later `lookup` cannot find the settlement. It also
     * breaks the unique index's guarantee that one charge maps to one key.
     * The provider's reference is recoverable via lookup if it is ever needed;
     * the key is not recoverable at all once discarded.
     */
    await tx
      .update(subscriptionCharges)
      .set({
        status: "succeeded",
        settledAt: now,
        failureDetail: `settled as ${providerSideRef}`,
        nextRetryAt: null,
      })
      .where(eq(subscriptionCharges.id, chargeId));

    /*
     * Payment restores full service from ANY dunning state, including
     * `restricted`. That reversibility is the point: the pharmacy fixed the
     * problem, and the product's job is to let them trade.
     */
    await tx
      .update(subscriptions)
      .set({ status: "active", restrictedAt: null, updatedAt: now })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          sql`${subscriptions.status} <> 'cancelled'`,
        ),
      );
  });
}

/** The worker entry point: everything whose retry is due. */
export async function processDueCharges(
  db: Database,
  deps: DunningDeps,
  limit = 100,
): Promise<ChargeAttemptResult[]> {
  const now = deps.now?.() ?? new Date();

  const due = await db
    .select({ id: subscriptionCharges.id })
    .from(subscriptionCharges)
    .where(
      and(
        sql`${subscriptionCharges.status} in ('retrying', 'pending')`,
        lte(subscriptionCharges.nextRetryAt, now),
      ),
    )
    .limit(limit);

  const results: ChargeAttemptResult[] = [];
  for (const charge of due) {
    results.push(await attemptCharge(db, deps, charge.id));
  }
  return results;
}

/**
 * §2 — whether a pharmacy may currently post shifts.
 *
 * `past_due` deliberately still can: they are inside the retry ladder and
 * probably unaware anything is wrong. Cutting them off at the first failed
 * charge would strand a pharmacy that needs cover over a card that expired
 * yesterday.
 */
export async function canPostShifts(
  db: Database,
  pharmacyId: string,
): Promise<boolean> {
  const [subscription] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.pharmacyId, pharmacyId),
        sql`${subscriptions.status} <> 'cancelled'`,
      ),
    )
    .limit(1);

  if (!subscription) return false;
  return subscription.status !== "restricted";
}

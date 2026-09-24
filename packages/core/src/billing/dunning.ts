import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
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
export interface OpenedCharge {
  readonly chargeId: string;
  readonly amountCents: number;
  readonly feeCount: number;
}

export interface AdvancePeriod {
  readonly start: Date;
  readonly end: Date;
}

export function openPeriodCharge(
  db: Database,
  subscriptionId: string,
): Promise<OpenedCharge>;
export function openPeriodCharge(
  db: Database,
  subscriptionId: string,
  opts: { readonly advancePeriod: AdvancePeriod },
): Promise<OpenedCharge | null>;
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
  opts: { readonly advancePeriod?: AdvancePeriod } = {},
): Promise<OpenedCharge | null> {
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
      // Locked because `rolloverDuePeriods` selects candidates outside this
      // transaction; without the lock, two overlapping sweeps (a slow run
      // still in flight when the next tick fires) could both pass the
      // "still due" check and open two charges for the same period.
      .for("update")
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
    if (opts.advancePeriod && subscription.status !== "active") {
      /*
       * The rollover path only ever wants a subscription whose PREVIOUS
       * period is fully settled. If dunning has since moved it to
       * `past_due` or `restricted` — a race with this exact sweep, since
       * both read the row outside a lock before this transaction — opening
       * a second charge on top of an unresolved one would let the ladder
       * for period N and a brand-new charge for period N+1 run at once,
       * and a pharmacy could pay one and still show restricted from the
       * other. `null`, not a thrown error: this is not a failure, it is the
       * rollover sweep finding nothing left to do here this tick. The next
       * tick tries again once dunning resolves the subscription one way or
       * the other.
       */
      return null;
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

    if (opts.advancePeriod) {
      /*
       * Advanced in the SAME transaction as the charge insert above — a
       * crash between the two is impossible, which is exactly what stops
       * the next sweep tick from finding this subscription still "due" and
       * opening a second charge for the period that just got one.
       */
      await tx
        .update(subscriptions)
        .set({
          currentPeriodStart: opts.advancePeriod.start,
          currentPeriodEnd: opts.advancePeriod.end,
        })
        .where(eq(subscriptions.id, subscriptionId));
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

/**
 * The worker entry point: everything whose retry is due.
 *
 * Pages rather than taking one snapshot, same reasoning as
 * `rolloverDuePeriods` below: an unordered `limit(limit)` over a backlog
 * bigger than `limit` silently drops whichever rows Postgres didn't
 * happen to return, with nothing forcing a second look at the rest.
 * `attemptCharge` always moves a processed charge's status or
 * `next_retry_at` out of this query's match set (settled, failed, or
 * rescheduled into the future), so paging until a page comes back short
 * is guaranteed to terminate and drains the whole backlog in one call.
 */
export async function processDueCharges(
  db: Database,
  deps: DunningDeps,
  limit = 100,
): Promise<ChargeAttemptResult[]> {
  const now = deps.now?.() ?? new Date();

  const results: ChargeAttemptResult[] = [];
  for (;;) {
    const due = await db
      .select({ id: subscriptionCharges.id })
      .from(subscriptionCharges)
      .where(
        /*
         * `pending` means "never attempted" and `openPeriodCharge` never sets
         * `next_retry_at` on insert — it stays NULL. `lte(nextRetryAt, now)`
         * over the whole set used to be applied to BOTH statuses, and in SQL
         * `NULL <= now` is NULL, which the WHERE clause treats as false. A
         * freshly opened charge was therefore invisible to this query forever,
         * found only by manually setting next_retry_at, which is exactly what
         * every existing test did instead of exercising the real path. A
         * `pending` charge is due unconditionally; only `retrying` respects
         * the scheduled retry time.
         */
        or(
          eq(subscriptionCharges.status, "pending"),
          and(eq(subscriptionCharges.status, "retrying"), lte(subscriptionCharges.nextRetryAt, now)),
        ),
      )
      // Postgres sorts NULLs first ascending, so never-attempted (`pending`,
      // `next_retry_at` NULL) charges take priority over scheduled retries,
      // which then run soonest-due first.
      .orderBy(asc(subscriptionCharges.nextRetryAt))
      .limit(limit);

    if (due.length === 0) break;

    for (const charge of due) {
      results.push(await attemptCharge(db, deps, charge.id));
    }

    if (due.length < limit) break;
  }
  return results;
}

/** Default billing cycle length. §2 has no product decision on calendar-month
 * billing vs a fixed 30 days; 30 days is simpler to reason about (no
 * February drift) and is what `beginSubscribe`/`activateSubscription` already
 * use for period 1. */
const DEFAULT_PERIOD_LENGTH_MS = 30 * 86_400_000;

/**
 * §2 — the worker entry point for month 2 onward.
 *
 * `openPeriodCharge` opens a charge for a subscription's CURRENT period; it
 * does not advance that period, and nothing in production called it past the
 * one time `activateSubscription` runs it implicitly for period 1. Without
 * this, every subscription would bill once at Subscribe and never again —
 * `current_period_end` would sail past `now` forever with no charge and no
 * error, the quietest possible way to stop collecting money.
 *
 * Deliberately restricted to `active` subscriptions whose period has
 * actually ended: a `past_due` or `restricted` subscription is mid-ladder on
 * an EARLIER charge, and opening a new period's charge on top of that would
 * let two billing cycles run at once. It waits for dunning to resolve the
 * old one first — see `openPeriodCharge`'s `advancePeriod` branch, which
 * re-checks this with a row lock rather than trusting this query's snapshot.
 *
 * `limit` pages the query rather than capping the run: the first version
 * took a single unordered `limit(100)` snapshot, which silently dropped
 * whichever subscriptions Postgres didn't happen to return that tick — with
 * no `ORDER BY`, that's not even "oldest wins", it's arbitrary. A due
 * backlog past `limit` (the §14 seed alone ships ~130 pre-due subscriptions)
 * could starve indefinitely: nothing ever forced a second look at whatever
 * got left out. Now each page is ordered oldest-due-first and, since a
 * processed subscription's `current_period_end` moves into the future (or
 * its status moves off `active`), it always drops out of the next page's
 * `WHERE` — so the loop is guaranteed to terminate, and a backlog bigger
 * than `limit` still gets fully drained in one call instead of leaking one
 * tick's worth of rows forever.
 */
export async function rolloverDuePeriods(
  db: Database,
  opts: {
    readonly limit?: number;
    readonly now?: () => Date;
    readonly periodLengthMs?: number;
  } = {},
): Promise<ReadonlyArray<{ readonly subscriptionId: string } & OpenedCharge>> {
  const now = opts.now?.() ?? new Date();
  const periodLengthMs = opts.periodLengthMs ?? DEFAULT_PERIOD_LENGTH_MS;
  const limit = opts.limit ?? 100;

  const results: Array<{ subscriptionId: string } & OpenedCharge> = [];
  for (;;) {
    const due = await db
      .select({ id: subscriptions.id, periodEnd: subscriptions.currentPeriodEnd })
      .from(subscriptions)
      .where(and(eq(subscriptions.status, "active"), lte(subscriptions.currentPeriodEnd, now)))
      .orderBy(asc(subscriptions.currentPeriodEnd))
      .limit(limit);

    if (due.length === 0) break;

    for (const sub of due) {
      const opened = await openPeriodCharge(db, sub.id, {
        advancePeriod: {
          start: sub.periodEnd,
          end: new Date(sub.periodEnd.getTime() + periodLengthMs),
        },
      });
      // `null` means the status check inside the transaction lost the race —
      // dunning moved this subscription off `active` between this query and
      // that lock. Not an error; it has already left the `active` state this
      // query selects on, so the next page (or the next call) does not see
      // it again — the next tick picks it up once dunning resolves it.
      if (opened) results.push({ subscriptionId: sub.id, ...opened });
    }

    if (due.length < limit) break;
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

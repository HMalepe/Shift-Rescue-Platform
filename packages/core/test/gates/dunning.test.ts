import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  FakePaymentProvider,
  MAX_ATTEMPTS,
  attemptCharge,
  canPostShifts,
  openPeriodCharge,
  processDueCharges,
  rolloverDuePeriods,
  type DunningDeps,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: billing.dunning
 *
 * §2's state machine, exercised against the §0.2 failure modes: card decline,
 * retry success, settlement-day outage, and timeout mid-charge.
 *
 * The timeout case carries the most risk and gets the most attention below.
 * A dunning implementation that treats "no answer" as "failed" will charge a
 * pharmacy twice for one month, which costs trust that a refund does not buy
 * back.
 *
 * NOTE ON SCOPE: §15 classes this gate as G -> X. Everything here runs against
 * a fake provider. Closing it properly needs a Payfast sandbox driven into
 * each error state, which is externally blocked — so this proves the state
 * machine, not the integration.
 */

const { db, client } = connect();
const pharmacyIds: string[] = [];

const JHB = { lng: 28.0473, lat: -26.2041 };

function deps(provider: FakePaymentProvider, overrides: Partial<DunningDeps> = {}) {
  return { provider, ...overrides } as DunningDeps;
}

async function makeSubscription(
  monthlyCents = 89_900,
  options: { tokenized?: boolean } = {},
) {
  const [pharmacy] = await db
    .insert(s.pharmacies)
    .values({
      name: `Dunning Pharmacy ${Date.now()}${Math.random()}`,
      addressLine: "1 Road",
      city: "Johannesburg",
      location: JHB,
    })
    .returning({ id: s.pharmacies.id });
  pharmacyIds.push(pharmacy!.id);

  const tokenized = options.tokenized ?? true;

  const [subscription] = await db
    .insert(s.subscriptions)
    .values({
      pharmacyId: pharmacy!.id,
      status: "active",
      provider: "payfast",
      // The actual Payfast mandate token `attemptCharge` sends as
      // `subscriptionRef`. Every existing test needs one now that a missing
      // mandate is a thrown error rather than a silently-wrong charge target
      // — see the regression this guards against in dunning.ts.
      ...(tokenized ? { providerRef: `pf_token_${Date.now()}${Math.random()}` } : {}),
      monthlyCents,
      currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    })
    .returning({ id: s.subscriptions.id });

  return { pharmacyId: pharmacy!.id, subscriptionId: subscription!.id };
}

async function statusOf(subscriptionId: string) {
  const [row] = await db
    .select({ status: s.subscriptions.status })
    .from(s.subscriptions)
    .where(eq(s.subscriptions.id, subscriptionId));
  return row?.status;
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
      .delete(s.cancellationFees)
      .where(inArray(s.cancellationFees.subscriptionId, subIds));
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

describe("GATE billing.dunning — the happy path", () => {
  it("collects and keeps the subscription active", async () => {
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();

    const { chargeId, amountCents } = await openPeriodCharge(db, subscriptionId);
    expect(amountCents).toBe(89_900);

    const result = await attemptCharge(db, deps(provider), chargeId);
    expect(result.outcome).toBe("succeeded");
    expect(await statusOf(subscriptionId)).toBe("active");
  });

  it("sends the subscription's PAYFAST MANDATE, not our internal row id", async () => {
    /*
     * The regression this guards against: `attemptCharge` used to send
     * `subscriptionCharges.subscriptionId` (our own row) as `subscriptionRef`
     * instead of `subscriptions.providerRef` (the actual token Payfast
     * issued). `FakePaymentProvider` cannot tell the difference — it accepts
     * any string — which is exactly why no test caught it before this one was
     * written to check the value received rather than only the outcome
     * returned.
     */
    const [pharmacy] = await db
      .insert(s.pharmacies)
      .values({
        name: `Dunning Mandate Pharmacy ${Date.now()}${Math.random()}`,
        addressLine: "1 Road",
        city: "Johannesburg",
        location: JHB,
      })
      .returning({ id: s.pharmacies.id });
    pharmacyIds.push(pharmacy!.id);

    const mandateToken = `pf_token_${Date.now()}`;
    const [subscription] = await db
      .insert(s.subscriptions)
      .values({
        pharmacyId: pharmacy!.id,
        status: "active",
        provider: "payfast",
        providerRef: mandateToken,
        monthlyCents: 89_900,
        currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      })
      .returning({ id: s.subscriptions.id });

    const provider = new FakePaymentProvider();
    const { chargeId } = await openPeriodCharge(db, subscription!.id);
    await attemptCharge(db, deps(provider), chargeId);

    expect(provider.subscriptionRefs).toEqual([mandateToken]);
    expect(provider.subscriptionRefs[0]).not.toBe(subscription!.id);
  });

  it("refuses to charge a subscription with no payment mandate on file", async () => {
    /*
     * A subscription created before `billing.subscribe`'s Payfast tokenization
     * step completes — or one where it silently failed — has nothing for
     * `subscriptionRef` to name. This must be a thrown error, not a charge
     * attempt with a garbage reference and not a silent `unknown`: the retry
     * ladder does not apply to "we never had a way to bill this", and treating
     * it as a transient outage would burn an hourly retry forever against a
     * mandate that will never appear on its own.
     */
    const { subscriptionId } = await makeSubscription(89_900, { tokenized: false });
    const provider = new FakePaymentProvider();

    const { chargeId } = await openPeriodCharge(db, subscriptionId);

    await expect(attemptCharge(db, deps(provider), chargeId)).rejects.toMatchObject({
      code: "SUBSCRIPTION_NOT_TOKENIZED",
    });
    // Nothing was sent to the provider at all.
    expect(provider.attempts).toHaveLength(0);
  });

  it("folds unbilled late-cancellation fees into the invoice (§9)", async () => {
    const { subscriptionId } = await makeSubscription();

    // Two R10 fees accrued during the period. §9: "R10 is added to the
    // month's subscription" — not billed as its own transaction, which would
    // cost more in provider fees than it collects.
    const [pharmacy] = await db
      .select({ id: s.subscriptions.pharmacyId })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, subscriptionId));

    const [manager] = await db
      .insert(s.users)
      .values({ role: "manager", email: `dun-${Date.now()}@t.invalid`, fullName: "M" })
      .returning({ id: s.users.id });
    const [locum] = await db
      .insert(s.users)
      .values({ role: "locum", email: `dun-l-${Date.now()}@t.invalid`, fullName: "L" })
      .returning({ id: s.users.id });
    await db.insert(s.locumProfiles).values({ userId: locum!.id });

    const [shift] = await db
      .insert(s.shifts)
      .values({
        pharmacyId: pharmacy!.id,
        createdBy: manager!.id,
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 5 * 3_600_000),
        hourlyRateCents: 45_000,
        location: JHB,
      })
      .returning({ id: s.shifts.id });

    const created = await db
      .insert(s.bookings)
      .values([
        { shiftId: shift!.id, locumId: locum!.id, status: "cancelled_by_locum" },
      ])
      .returning({ id: s.bookings.id });

    await db.insert(s.cancellationFees).values({
      bookingId: created[0]!.id,
      subscriptionId,
      amountCents: 1000,
      noticeHours: 2,
    });

    const { amountCents, feeCount } = await openPeriodCharge(db, subscriptionId);
    expect(feeCount).toBe(1);
    expect(amountCents).toBe(89_900 + 1000);

    // The fee is marked as billed in the same transaction, so a second run
    // cannot pick it up again.
    const second = await openPeriodCharge(db, subscriptionId);
    expect(second.feeCount).toBe(0);
    expect(second.amountCents).toBe(89_900);

    // cancellation_fees references bookings with ON DELETE RESTRICT, so the
    // fee must go first — the constraint doing its job.
    await db
      .delete(s.cancellationFees)
      .where(eq(s.cancellationFees.subscriptionId, subscriptionId));
    await db.delete(s.bookings).where(eq(s.bookings.shiftId, shift!.id));
    await db.delete(s.shifts).where(eq(s.shifts.id, shift!.id));
    await db.delete(s.locumProfiles).where(eq(s.locumProfiles.userId, locum!.id));
    await db.delete(s.users).where(inArray(s.users.id, [manager!.id, locum!.id]));
  });
});

describe("GATE billing.dunning — §0.2 card decline and the retry ladder", () => {
  it("moves to past_due and schedules a retry, without restricting immediately", async () => {
    const { subscriptionId, pharmacyId } = await makeSubscription();
    const provider = new FakePaymentProvider();
    provider.scriptOutcomes({
      kind: "decline",
      failureCode: "insufficient_funds",
      permanent: false,
    });

    const { chargeId } = await openPeriodCharge(db, subscriptionId);
    const result = await attemptCharge(db, deps(provider), chargeId);

    expect(result.outcome).toBe("retrying");
    expect(result.nextRetryAt).toBeInstanceOf(Date);
    expect(await statusOf(subscriptionId)).toBe("past_due");

    /*
     * A past_due pharmacy can still post shifts. They are inside the ladder
     * and probably unaware anything is wrong — cutting them off over a card
     * that expired yesterday would strand a pharmacy that needs cover.
     */
    expect(await canPostShifts(db, pharmacyId)).toBe(true);
  });

  it("recovers to active when a retry succeeds (§0.2 retry success)", async () => {
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();
    provider.scriptOutcomes(
      { kind: "decline", failureCode: "insufficient_funds", permanent: false },
      { kind: "succeed" },
    );

    const { chargeId } = await openPeriodCharge(db, subscriptionId);
    await attemptCharge(db, deps(provider), chargeId);
    expect(await statusOf(subscriptionId)).toBe("past_due");

    const recovered = await attemptCharge(db, deps(provider), chargeId);
    expect(recovered.outcome).toBe("succeeded");
    expect(await statusOf(subscriptionId)).toBe("active");
  });

  it("restricts once the ladder is exhausted, and restriction is reversible", async () => {
    const { subscriptionId, pharmacyId } = await makeSubscription();
    const provider = new FakePaymentProvider();
    let restrictedAlert: { subscriptionId: string } | undefined;

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      provider.scriptOutcomes({
        kind: "decline",
        failureCode: "insufficient_funds",
        permanent: false,
      });
    }

    const { chargeId } = await openPeriodCharge(db, subscriptionId);
    const d = deps(provider, {
      onRestricted: (c) => {
        restrictedAlert = c;
      },
    });

    let last;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      last = await attemptCharge(db, d, chargeId);
    }

    expect(last?.outcome).toBe("restricted");
    expect(await statusOf(subscriptionId)).toBe("restricted");
    expect(restrictedAlert?.subscriptionId).toBe(subscriptionId);

    // Restricted means: keep the data, keep collecting, stop posting.
    expect(await canPostShifts(db, pharmacyId)).toBe(false);

    /*
     * And it is REVERSIBLE. A card failing is usually an expiry, not a
     * decision to leave; paying restores full service rather than requiring a
     * new account.
     */
    provider.scriptOutcomes({ kind: "succeed" });
    const paid = await attemptCharge(db, d, chargeId);
    expect(paid.outcome).toBe("succeeded");
    expect(await statusOf(subscriptionId)).toBe("active");
    expect(await canPostShifts(db, pharmacyId)).toBe(true);
  });

  it("skips the ladder for a permanently failed card", async () => {
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();
    provider.scriptOutcomes({
      kind: "decline",
      failureCode: "card_expired",
      permanent: true,
    });

    const { chargeId } = await openPeriodCharge(db, subscriptionId);
    const result = await attemptCharge(db, deps(provider), chargeId);

    // Retrying a card that cannot work wastes days in which nobody is being
    // told to fix anything.
    expect(result.outcome).toBe("restricted");
    expect(await statusOf(subscriptionId)).toBe("restricted");
  });
});

describe("GATE billing.dunning — §0.2 timeout mid-charge", () => {
  it("NEVER double-charges when the response is lost after settlement", async () => {
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();

    // Settles at the provider, then the answer is lost — a network timeout
    // after a successful charge.
    provider.scriptOutcomes({ kind: "timeout_after_success" });

    const { chargeId } = await openPeriodCharge(db, subscriptionId);

    const first = await attemptCharge(db, deps(provider), chargeId);
    expect(first.outcome).toBe("unresolved");

    // The retry reconciles against the provider before moving any money.
    const second = await attemptCharge(db, deps(provider), chargeId);
    expect(second.outcome).toBe("succeeded");
    expect(await statusOf(subscriptionId)).toBe("active");

    /*
     * The heart of it: the money moved exactly once. A dunning implementation
     * that treats "no answer" as "failed" bills the pharmacy twice for one
     * month — a trust problem a refund does not undo.
     */
    const [charge] = await db
      .select({ providerRef: s.subscriptionCharges.providerRef })
      .from(s.subscriptionCharges)
      .where(eq(s.subscriptionCharges.id, chargeId));
    expect(provider.attemptsFor(charge!.providerRef!)).toBe(1);
  });

  it("does NOT burn a retry attempt on a provider outage", async () => {
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();
    provider.scriptOutcomes(
      { kind: "outage", detail: "settlement day outage" },
      { kind: "outage", detail: "still down" },
    );

    const { chargeId } = await openPeriodCharge(db, subscriptionId);

    const first = await attemptCharge(db, deps(provider), chargeId);
    const second = await attemptCharge(db, deps(provider), chargeId);

    expect(first.outcome).toBe("unresolved");
    expect(second.outcome).toBe("unresolved");

    /*
     * A vendor being down is not the pharmacy failing to pay. Advancing the
     * ladder here would restrict an account that never declined — punishing a
     * customer for our supplier's outage.
     */
    expect(second.attempt).toBe(1);
    expect(await statusOf(subscriptionId)).toBe("active");
  });

  it("stays collectible after an outage clears", async () => {
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();
    provider.scriptOutcomes({ kind: "outage", detail: "down" }, { kind: "succeed" });

    const { chargeId } = await openPeriodCharge(db, subscriptionId);
    await attemptCharge(db, deps(provider), chargeId);

    const recovered = await attemptCharge(db, deps(provider), chargeId);
    expect(recovered.outcome).toBe("succeeded");
  });
});

describe("GATE billing.dunning — the worker", () => {
  it("picks up charges whose retry is due and leaves future ones alone", async () => {
    const dueSub = await makeSubscription();
    const futureSub = await makeSubscription();
    const provider = new FakePaymentProvider();

    const due = await openPeriodCharge(db, dueSub.subscriptionId);
    const future = await openPeriodCharge(db, futureSub.subscriptionId);

    await db
      .update(s.subscriptionCharges)
      .set({ status: "retrying", nextRetryAt: new Date(Date.now() - 3_600_000) })
      .where(eq(s.subscriptionCharges.id, due.chargeId));
    await db
      .update(s.subscriptionCharges)
      .set({ status: "retrying", nextRetryAt: new Date(Date.now() + 86_400_000) })
      .where(eq(s.subscriptionCharges.id, future.chargeId));

    const results = await processDueCharges(db, deps(provider));
    const ids = results.map((r) => r.chargeId);

    expect(ids).toContain(due.chargeId);
    expect(ids).not.toContain(future.chargeId);
  });

  it("picks up a freshly opened charge with no next_retry_at set (the real openPeriodCharge shape)", async () => {
    /*
     * The regression this guards against: the WHERE clause used to apply
     * `next_retry_at <= now` to BOTH 'pending' and 'retrying' rows, and SQL's
     * `NULL <= now` is NULL — which a WHERE clause treats as false.
     * `openPeriodCharge` never sets `next_retry_at` on insert, so every
     * charge it ever opened was invisible to this query forever. Every OTHER
     * test in this file works around it by manually setting next_retry_at
     * before calling processDueCharges — this one calls openPeriodCharge and
     * changes nothing else, which is the actual path production goes through.
     */
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();

    const opened = await openPeriodCharge(db, subscriptionId);

    const [row] = await db
      .select({ nextRetryAt: s.subscriptionCharges.nextRetryAt })
      .from(s.subscriptionCharges)
      .where(eq(s.subscriptionCharges.id, opened.chargeId));
    expect(row?.nextRetryAt).toBeNull();

    const results = await processDueCharges(db, deps(provider));
    expect(results.map((r) => r.chargeId)).toContain(opened.chargeId);
  });

  it("re-attempting a settled charge is a no-op", async () => {
    const { subscriptionId } = await makeSubscription();
    const provider = new FakePaymentProvider();

    const { chargeId } = await openPeriodCharge(db, subscriptionId);
    await attemptCharge(db, deps(provider), chargeId);

    const attemptsBefore = provider.attempts.length;
    const repeat = await attemptCharge(db, deps(provider), chargeId);

    expect(repeat.outcome).toBe("succeeded");
    // No second call to the provider at all.
    expect(provider.attempts.length).toBe(attemptsBefore);
  });

  it("refuses to bill a cancelled subscription", async () => {
    const { subscriptionId } = await makeSubscription();
    await db
      .update(s.subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(s.subscriptions.id, subscriptionId));

    await expect(openPeriodCharge(db, subscriptionId)).rejects.toMatchObject({
      code: "SUBSCRIPTION_CANCELLED",
    });
  });
});

describe("GATE billing.dunning — month 2+ period rollover", () => {
  /*
   * Nothing in production ever called `openPeriodCharge` past the one time
   * `activateSubscription` runs it implicitly for period 1 — every
   * subscription billed exactly once, ever, and `current_period_end` would
   * sail past `now` silently forever. `rolloverDuePeriods` is the worker
   * entry point that closes that gap.
   */
  it("opens the next period's charge and advances the period for a subscription whose period has ended", async () => {
    const { subscriptionId } = await makeSubscription();
    const pastEnd = new Date(Date.now() - 3_600_000);
    await db
      .update(s.subscriptions)
      .set({ currentPeriodEnd: pastEnd })
      .where(eq(s.subscriptions.id, subscriptionId));

    const results = await rolloverDuePeriods(db);
    const mine = results.find((r) => r.subscriptionId === subscriptionId);
    expect(mine).toBeDefined();
    expect(mine?.amountCents).toBe(89_900);

    const [row] = await db
      .select({
        periodStart: s.subscriptions.currentPeriodStart,
        periodEnd: s.subscriptions.currentPeriodEnd,
      })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, subscriptionId));
    expect(row?.periodStart?.getTime()).toBe(pastEnd.getTime());
    expect(row?.periodEnd?.getTime()).toBe(pastEnd.getTime() + 30 * 86_400_000);
  });

  it("leaves a subscription whose period has not ended alone", async () => {
    const { subscriptionId } = await makeSubscription();
    // makeSubscription's default period ends 20 days in the future.
    const results = await rolloverDuePeriods(db);
    expect(results.map((r) => r.subscriptionId)).not.toContain(subscriptionId);
  });

  it("does not open a second charge for a subscription that is past_due, not active", async () => {
    const { subscriptionId } = await makeSubscription();
    await db
      .update(s.subscriptions)
      .set({ status: "past_due", currentPeriodEnd: new Date(Date.now() - 3_600_000) })
      .where(eq(s.subscriptions.id, subscriptionId));

    const results = await rolloverDuePeriods(db);
    expect(results.map((r) => r.subscriptionId)).not.toContain(subscriptionId);

    // The period must be untouched too — silently advancing it would let the
    // eventual dunning recovery collect for a period that was never actually
    // billed.
    const [row] = await db
      .select({ periodEnd: s.subscriptions.currentPeriodEnd })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, subscriptionId));
    expect(row?.periodEnd?.getTime()).toBeLessThan(Date.now());
  });

  it("is safe to call twice in a row — the second call finds nothing left due", async () => {
    const { subscriptionId } = await makeSubscription();
    await db
      .update(s.subscriptions)
      .set({ currentPeriodEnd: new Date(Date.now() - 3_600_000) })
      .where(eq(s.subscriptions.id, subscriptionId));

    const first = await rolloverDuePeriods(db);
    expect(first.map((r) => r.subscriptionId)).toContain(subscriptionId);

    const second = await rolloverDuePeriods(db);
    expect(second.map((r) => r.subscriptionId)).not.toContain(subscriptionId);

    const charges = await db
      .select({ id: s.subscriptionCharges.id })
      .from(s.subscriptionCharges)
      .where(eq(s.subscriptionCharges.subscriptionId, subscriptionId));
    expect(charges).toHaveLength(1);
  });

  it("folds unbilled cancellation fees into the rolled-over charge, same as a direct openPeriodCharge call", async () => {
    const { subscriptionId, pharmacyId } = await makeSubscription();
    await db
      .update(s.subscriptions)
      .set({ currentPeriodEnd: new Date(Date.now() - 3_600_000) })
      .where(eq(s.subscriptions.id, subscriptionId));

    const [manager] = await db
      .insert(s.users)
      .values({ role: "manager", email: `rollover-mgr-${Date.now()}@test.invalid`, fullName: "M" })
      .returning({ id: s.users.id });
    const [locum] = await db
      .insert(s.users)
      .values({ role: "locum", email: `rollover-locum-${Date.now()}@test.invalid`, fullName: "L" })
      .returning({ id: s.users.id });
    await db.insert(s.locumProfiles).values({ userId: locum!.id });
    const [shift] = await db
      .insert(s.shifts)
      .values({
        pharmacyId,
        createdBy: manager!.id,
        startsAt: new Date(Date.now() + 48 * 3_600_000),
        endsAt: new Date(Date.now() + 56 * 3_600_000),
        hourlyRateCents: 45_000,
        status: "open",
        location: JHB,
      })
      .returning({ id: s.shifts.id });
    const [booking] = await db
      .insert(s.bookings)
      .values({ shiftId: shift!.id, locumId: locum!.id, status: "cancelled_by_locum" })
      .returning({ id: s.bookings.id });
    await db.insert(s.cancellationFees).values({
      bookingId: booking!.id,
      subscriptionId,
      amountCents: 1000,
      noticeHours: 2,
    });

    const results = await rolloverDuePeriods(db);
    const mine = results.find((r) => r.subscriptionId === subscriptionId);
    expect(mine?.feeCount).toBe(1);
    expect(mine?.amountCents).toBe(89_900 + 1000);

    await db.delete(s.cancellationFees).where(eq(s.cancellationFees.subscriptionId, subscriptionId));
    await db.delete(s.bookings).where(eq(s.bookings.shiftId, shift!.id));
    await db.delete(s.shifts).where(eq(s.shifts.id, shift!.id));
    await db.delete(s.locumProfiles).where(eq(s.locumProfiles.userId, locum!.id));
    await db.delete(s.users).where(inArray(s.users.id, [manager!.id, locum!.id]));
  });
});

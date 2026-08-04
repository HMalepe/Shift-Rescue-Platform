import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  LATE_CANCELLATION_FEE_CENTS,
  cancelBooking,
  confirmBooking,
  pendingCancellationFees,
} from "../../src/index";
import {
  connect,
  createContendedShift,
  cleanupScenario,
  createOutsiderManager,
  cleanupOutsider,
  type ShiftScenario,
} from "../helpers/fixtures";

/**
 * GATE: product.cancellation
 *
 * §9 — the R10 charge is an accountability mechanism, not revenue. The
 * assertions that matter are about WHO is charged and WHEN the notice period
 * is frozen, because both are places where a plausible-looking implementation
 * would quietly do the wrong thing.
 */

const { db, client } = connect();

afterAll(async () => {
  await client.end();
});

/** A confirmed booking whose shift starts `hoursFromNow` from now. */
async function confirmedBookingStartingIn(hoursFromNow: number) {
  const scenario = await createContendedShift(db, 2);

  await db
    .update(s.shifts)
    .set({
      startsAt: new Date(Date.now() + hoursFromNow * 3_600_000),
      endsAt: new Date(Date.now() + (hoursFromNow + 8) * 3_600_000),
    })
    .where(eq(s.shifts.id, scenario.shiftId));

  await confirmBooking(db, {
    bookingId: scenario.bookingIds[0]!,
    actorId: scenario.managerId,
  });

  return { scenario, bookingId: scenario.bookingIds[0]! };
}

/** A live subscription so a fee has somewhere to land. */
async function giveSubscription(scenario: ShiftScenario) {
  const [subscription] = await db
    .insert(s.subscriptions)
    .values({
      pharmacyId: scenario.pharmacyId,
      status: "active",
      provider: "payfast",
      monthlyCents: 89_900,
      currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    })
    .returning({ id: s.subscriptions.id });
  return subscription!.id;
}

async function cleanupBilling(scenario: ShiftScenario) {
  await db
    .delete(s.cancellationFees)
    .where(eq(s.cancellationFees.bookingId, scenario.bookingIds[0]!));
  await db
    .delete(s.subscriptions)
    .where(eq(s.subscriptions.pharmacyId, scenario.pharmacyId));
}

describe("GATE product.cancellation — §9 the R10 charge", () => {
  it("charges R10 when notice is under 24 hours", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(3);
    const subscriptionId = await giveSubscription(scenario);

    try {
      const result = await cancelBooking(db, {
        bookingId,
        actorId: scenario.locumIds[0]!,
        reason: "ill",
      });

      expect(result.wasLate).toBe(true);
      expect(result.feeAppliedCents).toBe(LATE_CANCELLATION_FEE_CENTS);
      expect(LATE_CANCELLATION_FEE_CENTS).toBe(1000); // R10.00 in cents

      const pending = await pendingCancellationFees(db, subscriptionId);
      expect(pending.count).toBe(1);
      expect(pending.totalCents).toBe(1000);
    } finally {
      await cleanupBilling(scenario);
      await cleanupScenario(db, scenario);
    }
  });

  it("charges nothing when notice is comfortable", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(72);
    const subscriptionId = await giveSubscription(scenario);

    try {
      const result = await cancelBooking(db, {
        bookingId,
        actorId: scenario.locumIds[0]!,
      });

      expect(result.wasLate).toBe(false);
      expect(result.feeAppliedCents).toBeNull();
      expect((await pendingCancellationFees(db, subscriptionId)).count).toBe(0);
    } finally {
      await cleanupBilling(scenario);
      await cleanupScenario(db, scenario);
    }
  });

  it("bills the PHARMACY even when the LOCUM cancelled (§10.0)", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(2);
    const subscriptionId = await giveSubscription(scenario);

    try {
      await cancelBooking(db, { bookingId, actorId: scenario.locumIds[0]! });

      /*
       * The charge rides on the pharmacy's subscription, which is the only
       * money flow the platform touches (§10.0). A locum who cancels late is
       * never billed by us — the platform does not move money between a
       * pharmacy and a locum, and creating a way to would change its legal
       * position on labour broking.
       */
      const [fee] = await db
        .select({ subscriptionId: s.cancellationFees.subscriptionId })
        .from(s.cancellationFees)
        .where(eq(s.cancellationFees.bookingId, bookingId));

      expect(fee?.subscriptionId).toBe(subscriptionId);
    } finally {
      await cleanupBilling(scenario);
      await cleanupScenario(db, scenario);
    }
  });

  it("freezes the notice period at cancellation time", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(2);
    await giveSubscription(scenario);

    try {
      await cancelBooking(db, { bookingId, actorId: scenario.locumIds[0]! });

      // Reschedule the shift a week out AFTER the cancellation. Both ends
      // move — shifts_ends_after_starts rejects moving only one, which is the
      // constraint doing its job.
      await db
        .update(s.shifts)
        .set({
          startsAt: new Date(Date.now() + 7 * 86_400_000),
          endsAt: new Date(Date.now() + 7 * 86_400_000 + 8 * 3_600_000),
        })
        .where(eq(s.shifts.id, scenario.shiftId));

      /*
       * The fee must not evaporate. Recomputing notice on read would let a
       * manager reschedule a shift and retroactively erase a charge — or,
       * worse, create one that was never owed.
       */
      const [booking] = await db
        .select({ wasLate: s.bookings.wasLateCancellation })
        .from(s.bookings)
        .where(eq(s.bookings.id, bookingId));
      expect(booking?.wasLate).toBe(true);

      const [fee] = await db
        .select({ noticeHours: s.cancellationFees.noticeHours })
        .from(s.cancellationFees)
        .where(eq(s.cancellationFees.bookingId, bookingId));
      // Recorded for dispute resolution: "you gave us two hours" is checkable.
      expect(fee?.noticeHours).toBeLessThan(24);
    } finally {
      await cleanupBilling(scenario);
      await cleanupScenario(db, scenario);
    }
  });

  it("cancels successfully even with no subscription to charge", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(2);

    try {
      // Refusing the cancellation would strand a pharmacy mid-crisis over a
      // billing edge case.
      const result = await cancelBooking(db, {
        bookingId,
        actorId: scenario.locumIds[0]!,
      });
      expect(result.wasLate).toBe(true);
      expect(result.feeAppliedCents).toBeNull();
    } finally {
      await cleanupScenario(db, scenario);
    }
  });
});

describe("GATE product.cancellation — reopening and reputation", () => {
  it("reopens the shift so it can be filled again", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(48);

    try {
      const result = await cancelBooking(db, {
        bookingId,
        actorId: scenario.locumIds[0]!,
      });
      expect(result.shiftReopened).toBe(true);

      const [shift] = await db
        .select({ status: s.shifts.status })
        .from(s.shifts)
        .where(eq(s.shifts.id, scenario.shiftId));

      // The pharmacy still needs cover — that is the whole problem.
      expect(shift?.status).toBe("open");
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("a reopened shift can be confirmed again", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(48);

    try {
      await cancelBooking(db, { bookingId, actorId: scenario.locumIds[0]! });

      // The second applicant can now be confirmed — the partial unique index
      // only counts CONFIRMED bookings, so the cancelled one does not block.
      const result = await confirmBooking(db, {
        bookingId: scenario.bookingIds[1]!,
        actorId: scenario.managerId,
      });
      expect(result.bookingId).toBe(scenario.bookingIds[1]);
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("counts a late cancellation against the LOCUM only", async () => {
    const late = await confirmedBookingStartingIn(2);
    await giveSubscription(late.scenario);

    try {
      await cancelBooking(db, {
        bookingId: late.bookingId,
        actorId: late.scenario.locumIds[0]!,
      });

      const [profile] = await db
        .select({ lateCancellations: s.locumProfiles.lateCancellations })
        .from(s.locumProfiles)
        .where(eq(s.locumProfiles.userId, late.scenario.locumIds[0]!));
      expect(profile?.lateCancellations).toBe(1);
    } finally {
      await cleanupBilling(late.scenario);
      await cleanupScenario(db, late.scenario);
    }

    const byManager = await confirmedBookingStartingIn(2);
    await giveSubscription(byManager.scenario);

    try {
      await cancelBooking(db, {
        bookingId: byManager.bookingId,
        actorId: byManager.scenario.managerId,
      });

      /*
       * The asymmetry is the point: a manager cancelling late is not the
       * locum's fault, and §7's reliability signal is about who a manager can
       * rely on to turn up.
       */
      const [profile] = await db
        .select({ lateCancellations: s.locumProfiles.lateCancellations })
        .from(s.locumProfiles)
        .where(eq(s.locumProfiles.userId, byManager.scenario.locumIds[0]!));
      expect(profile?.lateCancellations).toBe(0);
    } finally {
      await cleanupBilling(byManager.scenario);
      await cleanupScenario(db, byManager.scenario);
    }
  });

  it("records who cancelled", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(48);

    try {
      const result = await cancelBooking(db, {
        bookingId,
        actorId: scenario.managerId,
      });
      expect(result.cancelledBy).toBe("manager");

      const [booking] = await db
        .select({ status: s.bookings.status })
        .from(s.bookings)
        .where(eq(s.bookings.id, bookingId));
      expect(booking?.status).toBe("cancelled_by_manager");
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses a third party who is neither the locum nor a manager there", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(48);
    const outsider = await createOutsiderManager(db);

    try {
      await expect(
        cancelBooking(db, { bookingId, actorId: outsider.id }),
      ).rejects.toMatchObject({ code: "NOT_BOOKING_PARTICIPANT" });
    } finally {
      await cleanupOutsider(db, outsider.id);
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses to cancel twice", async () => {
    const { scenario, bookingId } = await confirmedBookingStartingIn(48);

    try {
      await cancelBooking(db, { bookingId, actorId: scenario.locumIds[0]! });
      await expect(
        cancelBooking(db, { bookingId, actorId: scenario.locumIds[0]! }),
      ).rejects.toMatchObject({ code: "BOOKING_NOT_CANCELLABLE" });
    } finally {
      await cleanupScenario(db, scenario);
    }
  });
});

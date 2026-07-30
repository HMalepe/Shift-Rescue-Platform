import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { confirmBooking, countConfirmedBookings, isDomainError } from "../../src/index";
import {
  connect,
  createContendedShift,
  cleanupScenario,
  createOutsiderManager,
  cleanupOutsider,
} from "../helpers/fixtures";

/**
 * GATE: code.concurrency
 *
 * §12.3 requires the booking-confirmation row-locking to be exercised under
 * genuinely concurrent accept attempts. §12.4 requires that removing the fix
 * makes the test fail — "a test that passes both with and without the fix
 * verifies nothing."
 *
 * These run against real Postgres. A mocked database cannot exhibit
 * `FOR UPDATE` behaviour, and §0.1 is explicit that locking semantics do not
 * port between engines.
 */

const { db, client } = connect();

afterAll(async () => {
  await client.end();
});

describe("GATE code.concurrency — booking confirmation", () => {
  it("permits exactly one confirmation when 10 managers race", async () => {
    const scenario = await createContendedShift(db, 10);
    let fallbackHits = 0;

    try {
      // Promise.all dispatches all ten before any resolves, so they genuinely
      // contend inside Postgres rather than queueing in JS.
      const outcomes = await Promise.allSettled(
        scenario.bookingIds.map((bookingId) =>
          confirmBooking(
            db,
            { bookingId, actorId: scenario.managerId },
            { onUniqueViolationFallback: () => { fallbackHits += 1; } },
          ),
        ),
      );

      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");

      // The invariant.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      expect(await countConfirmedBookings(db, scenario.shiftId)).toBe(1);

      // Every loser gets a clean domain error, never a leaked driver error.
      for (const outcome of rejected) {
        const reason = (outcome as PromiseRejectedResult).reason;
        expect(isDomainError(reason)).toBe(true);
        expect(["SHIFT_ALREADY_FILLED", "SHIFT_NOT_OPEN"]).toContain(reason.code);
      }

      const [shift] = await db
        .select({ status: s.shifts.status })
        .from(s.shifts)
        .where(eq(s.shifts.id, scenario.shiftId));
      expect(shift?.status).toBe("filled");

      // The lock did the serialising: no caller ever reached the unique index.
      // This is the half of the mutation check that must hold WITH the fix.
      expect(fallbackHits).toBe(0);
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  /**
   * The mutation check §12.4 demands: remove the fix, and the test must fail.
   *
   * Same race, lock disabled. Note what does NOT change: the confirmed count is
   * still exactly 1, because the partial unique index — not the lock — is what
   * guarantees the invariant. A test asserting only "count === 1" would pass
   * with and without the lock, and would therefore verify nothing about it.
   *
   * What does change is how the losers are stopped. Without the lock they sail
   * past the status check and collide with the unique index, so the fallback
   * branch fires. With it, that branch is unreachable.
   *
   * Zero-vs-non-zero on that counter is the observable difference, and it is
   * what makes deleting `.for("update")` a test failure rather than a silent
   * regression.
   */
  it("without the row lock, losers reach the unique index instead", async () => {
    const scenario = await createContendedShift(db, 10);
    let fallbackHits = 0;

    try {
      await Promise.allSettled(
        scenario.bookingIds.map((bookingId) =>
          confirmBooking(
            db,
            {
              bookingId,
              actorId: scenario.managerId,
              __unsafeSkipRowLockForMutationTesting: true,
            },
            { onUniqueViolationFallback: () => { fallbackHits += 1; } },
          ),
        ),
      );

      // Unchanged: the schema-level invariant does not depend on the lock.
      expect(await countConfirmedBookings(db, scenario.shiftId)).toBe(1);

      // Changed: without the lock, callers reach the index. This is the
      // assertion that fails if the lock is reinstated here, and its mirror in
      // the previous test is the one that fails if the lock is removed there.
      expect(fallbackHits).toBeGreaterThan(0);
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses a manager from a different pharmacy", async () => {
    /*
     * Authorisation is enforced in the domain layer, not only at the API edge.
     * This test calls confirmBooking directly — exactly as the worker or a
     * future admin tool would — so it fails if the check is moved out to a
     * tRPC middleware and nothing is left behind here.
     */
    const scenario = await createContendedShift(db, 2);
    const outsider = await createOutsiderManager(db);

    try {
      await expect(
        confirmBooking(db, {
          bookingId: scenario.bookingIds[0]!,
          actorId: outsider.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_SHIFT_OWNER" });

      // Nothing was confirmed as a side effect of the rejected attempt.
      expect(await countConfirmedBookings(db, scenario.shiftId)).toBe(0);
    } finally {
      await cleanupOutsider(db, outsider.id);
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses to confirm a booking that is not in 'requested'", async () => {
    const scenario = await createContendedShift(db, 2);

    try {
      await confirmBooking(db, {
        bookingId: scenario.bookingIds[0]!,
        actorId: scenario.managerId,
      });

      // Re-confirming the same booking is not idempotent success — it is a
      // state error the caller must see.
      await expect(
        confirmBooking(db, {
          bookingId: scenario.bookingIds[0]!,
          actorId: scenario.managerId,
        }),
      ).rejects.toMatchObject({ code: "BOOKING_NOT_CONFIRMABLE" });

      expect(await countConfirmedBookings(db, scenario.shiftId)).toBe(1);
    } finally {
      await cleanupScenario(db, scenario);
    }
  });
});

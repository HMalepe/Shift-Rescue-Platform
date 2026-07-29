import { and, eq, sql } from "drizzle-orm";
import { bookings, shifts, type Database } from "@locum/db";
import { DomainError, isUniqueViolation } from "../errors";

export interface ConfirmBookingInput {
  readonly bookingId: string;
  /** The manager performing the confirmation. */
  readonly actorId: string;
  /**
   * Escape hatch for the §12.4 mutation check.
   *
   * §12.4: "remove the fix, and the test must fail. A test that passes both
   * with and without the fix verifies nothing."
   *
   * Rather than asking a human to hand-edit this file and remember to put it
   * back, the row lock can be disabled for a single call. The concurrency test
   * runs the same scenario twice — locked and unlocked — and asserts that the
   * unlocked run reaches the unique index (via `onUniqueViolationFallback`)
   * while the locked run never does. That makes the mutation check a permanent,
   * automated property of the suite instead of a one-off manual ritual.
   *
   * Never set this in application code. It is not reachable from any transport:
   * no tRPC procedure or worker job passes it.
   */
  readonly __unsafeSkipRowLockForMutationTesting?: boolean;
}

export interface ConfirmBookingResult {
  readonly bookingId: string;
  readonly shiftId: string;
  readonly locumId: string;
  readonly confirmedAt: Date;
}

export interface ConfirmBookingObservers {
  /**
   * Fired when a confirmation was stopped by the unique index rather than by
   * the status check — i.e. the row lock did not serialise this caller.
   *
   * With the lock in place this is unreachable: a loser acquires the lock,
   * re-reads a shift that is now `filled`, and returns before attempting any
   * write. Reaching this branch therefore means the lock is absent, bypassed,
   * or defeated by a transaction isolation change.
   *
   * Two uses, deliberately the same mechanism:
   *
   *   - In production, wire it to a counter. A non-zero rate is a real alert:
   *     the invariant still held (the index saw to that), but the code path
   *     protecting it has regressed and the next schema change might not be so
   *     lucky.
   *
   *   - In the §12.4 mutation check, count the calls. Zero with the lock,
   *     non-zero without it — which is the observable proof that the lock does
   *     work, rather than an assertion that it exists.
   */
  readonly onUniqueViolationFallback?: (context: {
    readonly shiftId: string;
    readonly bookingId: string;
  }) => void;
}

/**
 * Confirms a booking, filling the shift.
 *
 * This is the highest-stakes write in the product. A pharmacy legally cannot
 * trade without a responsible pharmacist on the floor, so:
 *
 *   - two locums confirmed against one shift means one of them travels across
 *     Johannesburg to a shift that is not theirs
 *   - zero confirmed when the manager believes there is one means the pharmacy
 *     cannot open
 *
 * Correctness rests on two overlapping mechanisms, and the distinction between
 * them matters:
 *
 *   1. `bookings_one_confirmed_per_shift`, a partial unique index. This is the
 *      actual guarantee. It holds even if every line below is wrong, and it
 *      holds against writers that never call this function at all — a psql
 *      session, a future migration, a second service.
 *
 *   2. The `FOR UPDATE` row lock taken here. This does NOT provide the
 *      guarantee; it provides the *ergonomics*. It serialises concurrent
 *      confirmations so the loser reads the already-filled shift and receives a
 *      clean SHIFT_ALREADY_FILLED, instead of colliding with (1) and surfacing
 *      a raw 23505 as a 500.
 *
 * Both are tested, separately, because they fail differently.
 */
export async function confirmBooking(
  db: Database,
  input: ConfirmBookingInput,
  observers: ConfirmBookingObservers = {},
): Promise<ConfirmBookingResult> {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select({
        id: bookings.id,
        shiftId: bookings.shiftId,
        locumId: bookings.locumId,
        status: bookings.status,
      })
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .limit(1);

    if (!booking) {
      throw new DomainError("BOOKING_NOT_FOUND", "Booking does not exist", {
        bookingId: input.bookingId,
      });
    }

    if (booking.status !== "requested") {
      throw new DomainError(
        "BOOKING_NOT_CONFIRMABLE",
        `Cannot confirm a booking in state '${booking.status}'`,
        { bookingId: booking.id, status: booking.status },
      );
    }

    /*
     * Lock the SHIFT row, not the booking row.
     *
     * The invariant being defended is "one confirmed booking per shift", and
     * competing confirmations are for *different* booking rows against the
     * *same* shift. Locking each booking row would let both transactions
     * proceed in parallel, each holding a lock nobody else wants, and the
     * conflict would only surface at the unique index. The shift row is the
     * single point of contention, so it is the thing to serialise on.
     */
    const lockedShift = input.__unsafeSkipRowLockForMutationTesting
      ? await tx
          .select({ id: shifts.id, status: shifts.status })
          .from(shifts)
          .where(eq(shifts.id, booking.shiftId))
          .limit(1)
      : await tx
          .select({ id: shifts.id, status: shifts.status })
          .from(shifts)
          .where(eq(shifts.id, booking.shiftId))
          .limit(1)
          .for("update");

    const shift = lockedShift[0];
    if (!shift) {
      throw new DomainError("SHIFT_NOT_FOUND", "Shift does not exist", {
        shiftId: booking.shiftId,
      });
    }

    // Re-read AFTER acquiring the lock. A confirmation that was in flight when
    // this transaction started has now committed and is visible, so this is the
    // check that actually catches the race.
    if (shift.status === "filled") {
      throw new DomainError(
        "SHIFT_ALREADY_FILLED",
        "This shift has already been filled",
        { shiftId: shift.id },
      );
    }

    if (shift.status !== "open") {
      throw new DomainError(
        "SHIFT_NOT_OPEN",
        `Cannot confirm against a shift in state '${shift.status}'`,
        { shiftId: shift.id, status: shift.status },
      );
    }

    const confirmedAt = new Date();

    try {
      await tx
        .update(bookings)
        .set({
          status: "confirmed",
          confirmedAt,
          confirmedBy: input.actorId,
          updatedAt: confirmedAt,
        })
        .where(eq(bookings.id, booking.id));
    } catch (error) {
      // Reachable only if the row lock was bypassed. Translated rather than
      // rethrown so callers see one error shape for one business outcome —
      // but reported first, because silently translating it would hide the
      // fact that the lock is no longer doing its job.
      if (isUniqueViolation(error, "bookings_one_confirmed_per_shift")) {
        observers.onUniqueViolationFallback?.({
          shiftId: shift.id,
          bookingId: booking.id,
        });
        throw new DomainError(
          "SHIFT_ALREADY_FILLED",
          "This shift has already been filled",
          { shiftId: shift.id },
        );
      }
      throw error;
    }

    await tx
      .update(shifts)
      .set({ status: "filled", updatedAt: confirmedAt })
      .where(eq(shifts.id, shift.id));

    /*
     * Losing applicants are left in 'requested' rather than auto-declined.
     *
     * A manager who confirms the wrong person needs to be able to reverse it,
     * and mass-declining here would destroy the queue they would reverse into.
     * The read path filters by shift status instead.
     */

    return {
      bookingId: booking.id,
      shiftId: shift.id,
      locumId: booking.locumId,
      confirmedAt,
    };
  });
}

/**
 * Count of confirmed bookings for a shift.
 *
 * Exists for the concurrency gate: the assertion that matters after N racing
 * confirmations is that this returns exactly 1, whatever the callers saw.
 */
export async function countConfirmedBookings(
  db: Database,
  shiftId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.shiftId, shiftId), eq(bookings.status, "confirmed")));
  return row?.count ?? 0;
}

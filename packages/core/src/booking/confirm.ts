import { and, eq, sql } from "drizzle-orm";
import {
  bookings,
  locumProfiles,
  pharmacyMembers,
  shifts,
  type Database,
} from "@locum/db";
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
    /*
     * ONE round trip acquires the lock and fetches everything needed to decide.
     *
     * This shape is a direct response to a measured problem. The first version
     * issued five sequential statements — select booking, lock shift, check
     * membership, update booking, update shift — three of them while HOLDING
     * the lock. Under load that hold time multiplies by every waiter: at 500
     * VUs across 40 shifts (~12 deep per shift) the k6 run measured p95 1.69s
     * on confirm.
     *
     * Nothing in the membership check depends on the lock, and the booking row
     * is reachable by join, so both fold into the locking statement. The
     * LEFT JOIN on pharmacy_members lets a missing membership be distinguished
     * from a missing booking, which an inner join would conflate into one
     * indistinguishable "no rows".
     *
     * `FOR UPDATE OF s` locks only the shift row. Locking the booking rows too
     * would serialise applicants against each other for no benefit — the
     * contended resource is the shift.
     */
    const lockClause = input.__unsafeSkipRowLockForMutationTesting
      ? sql``
      : sql` FOR UPDATE OF s`;

    const rows = await tx.execute<{
      booking_id: string;
      booking_status: string;
      locum_id: string;
      shift_id: string;
      shift_status: string;
      is_member: boolean;
      locum_verification: string | null;
    }>(sql`
      SELECT
        b.id           AS booking_id,
        b.status::text AS booking_status,
        b.locum_id     AS locum_id,
        s.id           AS shift_id,
        s.status::text AS shift_status,
        (pm.user_id IS NOT NULL) AS is_member,
        lp.verification::text AS locum_verification
      FROM ${bookings} b
      JOIN ${shifts} s ON s.id = b.shift_id
      LEFT JOIN ${pharmacyMembers} pm
        ON pm.pharmacy_id = s.pharmacy_id
       AND pm.user_id = ${input.actorId}::uuid
      LEFT JOIN ${locumProfiles} lp
        ON lp.user_id = b.locum_id
      WHERE b.id = ${input.bookingId}::uuid
    ` .append(lockClause));

    const row = (rows as unknown as Array<{
      booking_id: string;
      booking_status: string;
      locum_id: string;
      shift_id: string;
      shift_status: string;
      is_member: boolean;
      locum_verification: string | null;
    }>)[0];

    if (!row) {
      throw new DomainError("BOOKING_NOT_FOUND", "Booking does not exist", {
        bookingId: input.bookingId,
      });
    }

    /*
     * §5 — the platform's core promise to a manager is that SAPC registration
     * was actually checked. Enforced HERE rather than only in the tRPC apply
     * path, for the same reason the membership check moved down: a rule that
     * lives at the transport edge is not a rule, it is a habit of one caller.
     *
     * The apply endpoint already refuses an unverified locum, so in the normal
     * flow this never fires. It fires for every other way a `requested` row can
     * come to exist — the seed generator, a support script, a future bulk
     * import — and for a locum whose verification was REVOKED between applying
     * and being confirmed, which the apply-time check cannot see by
     * construction. That last case is the one that matters: it is exactly when
     * a manager must not be told someone is checked.
     *
     * Checked before the state test so an unverified applicant reads as
     * unverified rather than as some other kind of unconfirmable.
     */
    if (row.locum_verification !== "verified") {
      throw new DomainError(
        "LOCUM_NOT_VERIFIED",
        "This locum's SAPC registration is not verified",
        {
          bookingId: row.booking_id,
          locumId: row.locum_id,
          verification: row.locum_verification,
        },
      );
    }

    if (row.booking_status !== "requested") {
      throw new DomainError(
        "BOOKING_NOT_CONFIRMABLE",
        `Cannot confirm a booking in state '${row.booking_status}'`,
        { bookingId: row.booking_id, status: row.booking_status },
      );
    }

    /*
     * Authorisation, enforced in the domain layer rather than only at the
     * transport edge. The same function is called by the BullMQ worker and by
     * any future admin tool, so a rule checked only in a tRPC middleware would
     * be unenforced for every other caller.
     *
     * Membership doubles as the existence check: an outsider gets
     * NOT_SHIFT_OWNER whether or not the shift exists, so this cannot be used
     * to enumerate other pharmacies' shifts.
     */
    if (!row.is_member) {
      throw new DomainError(
        "NOT_SHIFT_OWNER",
        "You do not have permission to confirm bookings for this shift",
        { shiftId: row.shift_id },
      );
    }

    // Read AFTER the lock: a confirmation that was in flight when this
    // transaction began has now committed and is visible. This is the check
    // that actually catches the race.
    if (row.shift_status === "filled") {
      throw new DomainError(
        "SHIFT_ALREADY_FILLED",
        "This shift has already been filled",
        { shiftId: row.shift_id },
      );
    }

    if (row.shift_status !== "open") {
      throw new DomainError(
        "SHIFT_NOT_OPEN",
        `Cannot confirm against a shift in state '${row.shift_status}'`,
        { shiftId: row.shift_id, status: row.shift_status },
      );
    }

    const confirmedAt = new Date();
    // postgres.js will not bind a Date through a raw template; ISO text with
    // an explicit cast is unambiguous and avoids any client-side timezone
    // interpretation.
    const confirmedAtIso = confirmedAt.toISOString();

    /*
     * Both writes in ONE round trip via a CTE.
     *
     * They must be atomic with each other anyway — a confirmed booking against
     * a shift still marked 'open' is the inconsistency the load-test verifier
     * checks for — and issuing them separately just holds the lock for a second
     * network round trip.
     */
    try {
      await tx.execute(sql`
        WITH confirmed AS (
          UPDATE ${bookings}
             SET status = 'confirmed',
                 confirmed_at = ${confirmedAtIso}::timestamptz,
                 confirmed_by = ${input.actorId}::uuid,
                 updated_at = ${confirmedAtIso}::timestamptz
           WHERE id = ${row.booking_id}::uuid
          RETURNING shift_id
        )
        UPDATE ${shifts}
           SET status = 'filled',
               updated_at = ${confirmedAtIso}::timestamptz
         WHERE id = (SELECT shift_id FROM confirmed)
      `);
    } catch (error) {
      /*
       * Reachable only if the row lock was bypassed. Reported to the observer
       * BEFORE being translated: silently converting it would hide the fact
       * that the lock has stopped doing its job, and that counter is both the
       * §12.4 mutation check and the production regression alarm.
       */
      if (isUniqueViolation(error, "bookings_one_confirmed_per_shift")) {
        observers.onUniqueViolationFallback?.({
          shiftId: row.shift_id,
          bookingId: row.booking_id,
        });
        throw new DomainError(
          "SHIFT_ALREADY_FILLED",
          "This shift has already been filled",
          { shiftId: row.shift_id },
        );
      }
      throw error;
    }

    /*
     * Losing applicants stay 'requested' rather than being auto-declined. A
     * manager who confirms the wrong person needs to reverse it, and mass
     * declining would destroy the queue they would reverse into.
     */

    return {
      bookingId: row.booking_id,
      shiftId: row.shift_id,
      locumId: row.locum_id,
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

import { and, eq, sql } from "drizzle-orm";
import {
  bookings,
  cancellationFees,
  locumProfiles,
  pharmacyMembers,
  shifts,
  subscriptions,
  type Database,
} from "@locum/db";
import { DomainError } from "../errors";

/**
 * §9 — cancelling a confirmed booking, and the R10 accountability charge.
 *
 * The framing in the spec is deliberate and worth preserving in code: this is
 * "reframed cancellation service fees", an accountability mechanism rather
 * than a revenue driver. R10 is "small enough that nobody feels robbed, real
 * enough that late cancellations carry a consequence" — because a late
 * cancellation can leave a pharmacy legally unable to trade.
 *
 * The charge always lands on the PHARMACY's subscription (§10.0): the platform
 * never moves money between a pharmacy and a locum, so a locum who cancels
 * late is not billed by us. The pharmacy's own arrangement with that locum is
 * theirs. What the platform provides is the record.
 */

/** §9 — under this much notice, the charge applies. */
export const LATE_CANCELLATION_THRESHOLD_HOURS = 24;
export const LATE_CANCELLATION_FEE_CENTS = 1000;

export interface CancelBookingInput {
  readonly bookingId: string;
  readonly actorId: string;
  readonly reason?: string;
}

export interface CancelBookingResult {
  readonly bookingId: string;
  readonly shiftId: string;
  readonly cancelledBy: "locum" | "manager";
  readonly noticeHours: number;
  readonly wasLate: boolean;
  readonly feeAppliedCents: number | null;
  /** The shift returns to `open` so it can be filled again. */
  readonly shiftReopened: boolean;
}

export async function cancelBooking(
  db: Database,
  input: CancelBookingInput,
): Promise<CancelBookingResult> {
  return db.transaction(async (tx) => {
    /*
     * Lock the shift, as the confirm path does and for the same reason: this
     * transaction flips the shift back to `open`, and a confirmation racing
     * with a cancellation must serialise or the shift ends up filled with a
     * cancelled booking.
     */
    const rows = await tx.execute<{
      booking_id: string;
      booking_status: string;
      locum_id: string;
      shift_id: string;
      shift_status: string;
      starts_at: Date;
      pharmacy_id: string;
      is_manager: boolean;
    }>(sql`
      SELECT
        b.id           AS booking_id,
        b.status::text AS booking_status,
        b.locum_id     AS locum_id,
        s.id           AS shift_id,
        s.status::text AS shift_status,
        s.starts_at    AS starts_at,
        s.pharmacy_id  AS pharmacy_id,
        (pm.user_id IS NOT NULL) AS is_manager
      FROM ${bookings} b
      JOIN ${shifts} s ON s.id = b.shift_id
      LEFT JOIN ${pharmacyMembers} pm
        ON pm.pharmacy_id = s.pharmacy_id
       AND pm.user_id = ${input.actorId}::uuid
      WHERE b.id = ${input.bookingId}::uuid
      FOR UPDATE OF s
    `);

    const row = (rows as unknown as Array<Record<string, never>>)[0] as
      | {
          booking_id: string;
          booking_status: string;
          locum_id: string;
          shift_id: string;
          shift_status: string;
          starts_at: Date;
          pharmacy_id: string;
          is_manager: boolean;
        }
      | undefined;

    if (!row) {
      throw new DomainError("BOOKING_NOT_FOUND", "Booking does not exist", {
        bookingId: input.bookingId,
      });
    }

    /*
     * Either side may cancel — that is the point of recording who did.
     * Anyone else may not, and gets the same error whether or not the booking
     * exists.
     */
    const isLocum = row.locum_id === input.actorId;
    if (!isLocum && !row.is_manager) {
      throw new DomainError(
        "NOT_BOOKING_PARTICIPANT",
        "You do not have permission to cancel this booking",
        { bookingId: row.booking_id },
      );
    }

    if (row.booking_status !== "confirmed") {
      throw new DomainError(
        "BOOKING_NOT_CANCELLABLE",
        `Cannot cancel a booking in state '${row.booking_status}'`,
        { bookingId: row.booking_id, status: row.booking_status },
      );
    }

    const now = new Date();
    const startsAt = new Date(row.starts_at);
    const noticeMs = startsAt.getTime() - now.getTime();
    const noticeHours = Math.floor(noticeMs / 3_600_000);

    /*
     * §9 — evaluated NOW and frozen, not recomputed on read.
     *
     * The schema comment on `was_late_cancellation` says why: rescheduling the
     * shift later must not retroactively change whether a fee was owed. The
     * notice figure is stored alongside for dispute resolution, so "you gave
     * us three hours" is checkable rather than asserted.
     */
    const wasLate = noticeHours < LATE_CANCELLATION_THRESHOLD_HOURS;
    const cancelledBy = isLocum ? ("locum" as const) : ("manager" as const);

    await tx
      .update(bookings)
      .set({
        status: isLocum ? "cancelled_by_locum" : "cancelled_by_manager",
        cancelledAt: now,
        cancelledBy: input.actorId,
        wasLateCancellation: wasLate,
        ...(input.reason !== undefined && { cancellationReason: input.reason }),
        updatedAt: now,
      })
      .where(eq(bookings.id, row.booking_id));

    /*
     * The shift reopens so it can be filled again — the pharmacy still needs
     * cover, which is the entire problem. It only reopens if it has not since
     * been cancelled outright by the manager.
     */
    const shiftReopened = row.shift_status === "filled";
    if (shiftReopened) {
      await tx
        .update(shifts)
        .set({ status: "open", updatedAt: now })
        .where(eq(shifts.id, row.shift_id));
    }

    let feeAppliedCents: number | null = null;

    if (wasLate) {
      const [subscription] = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.pharmacyId, row.pharmacy_id),
            sql`${subscriptions.status} <> 'cancelled'`,
          ),
        )
        .limit(1);

      /*
       * No live subscription means nothing to charge against. The cancellation
       * still succeeds — refusing it would strand a pharmacy mid-crisis over a
       * billing edge case — and the absence is simply not recorded as a fee.
       */
      if (subscription) {
        await tx
          .insert(cancellationFees)
          .values({
            bookingId: row.booking_id,
            subscriptionId: subscription.id,
            amountCents: LATE_CANCELLATION_FEE_CENTS,
            noticeHours: Math.max(0, noticeHours),
          })
          // A booking can only ever incur one fee; the unique index enforces
          // it and this keeps a retry idempotent rather than erroring.
          .onConflictDoNothing({ target: cancellationFees.bookingId });

        feeAppliedCents = LATE_CANCELLATION_FEE_CENTS;
      }
    }

    /*
     * §7 — reliability. A late cancellation by the LOCUM counts against them;
     * one by the manager does not, because the locum did nothing wrong. The
     * asymmetry is the point: the reputation signal is about who a manager can
     * rely on to turn up.
     */
    if (isLocum && wasLate) {
      await tx
        .update(locumProfiles)
        .set({
          lateCancellations: sql`${locumProfiles.lateCancellations} + 1`,
          updatedAt: now,
        })
        .where(eq(locumProfiles.userId, row.locum_id));
    }

    return {
      bookingId: row.booking_id,
      shiftId: row.shift_id,
      cancelledBy,
      noticeHours,
      wasLate,
      feeAppliedCents,
      shiftReopened,
    };
  });
}

/** Unbilled late-cancellation fees for a subscription, for the next invoice. */
export async function pendingCancellationFees(
  db: Database,
  subscriptionId: string,
): Promise<{ readonly count: number; readonly totalCents: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      totalCents: sql<number>`coalesce(sum(${cancellationFees.amountCents}), 0)::int`,
    })
    .from(cancellationFees)
    .where(
      and(
        eq(cancellationFees.subscriptionId, subscriptionId),
        sql`${cancellationFees.appliedToChargeId} is null`,
        sql`${cancellationFees.waivedAt} is null`,
      ),
    );

  return { count: row?.count ?? 0, totalCents: row?.totalCents ?? 0 };
}

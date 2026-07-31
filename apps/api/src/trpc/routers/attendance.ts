import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { bookings, checkIns, pharmacyMembers, shifts, users } from "@locum/db";
import { checkIn, checkOut, getAttendance } from "@locum/core";
import { router, locumProcedure, managerProcedure } from "../trpc";

/**
 * Coordinate input.
 *
 * Bounds are enforced at the edge as well as at the storage layer: PostGIS
 * silently normalises an out-of-range longitude rather than rejecting it, so a
 * client unit bug would otherwise become a plausible-looking row in the wrong
 * hemisphere.
 */
const coordinate = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

const attendanceInput = z.object({
  bookingId: z.string().uuid(),
  location: coordinate,
  /** GPS accuracy radius in metres. Capped at 100 km to reject nonsense. */
  accuracyM: z.number().int().min(0).max(100_000).optional(),
  /**
   * §16 — Android `isFromMockProvider()`. Optional because a web client cannot
   * produce it at all; absent is meaningfully different from false.
   */
  mockLocationDetected: z.boolean().optional(),
  deviceSignals: z.record(z.unknown()).optional(),
});

export const attendanceRouter = router({
  /**
   * §8 — a locum records their own arrival.
   *
   * Note what the client does NOT send: the distance from the pharmacy. It
   * sends a claimed coordinate, and the server measures against the pharmacy's
   * stored location. A distance supplied by the device is a number the device
   * chose, which is worthless as evidence in a dispute.
   */
  checkIn: locumProcedure
    .input(attendanceInput)
    .mutation(async ({ ctx, input }) => {
      return checkIn(ctx.db, {
        bookingId: input.bookingId,
        actorId: ctx.user.id,
        location: input.location,
        ...(input.accuracyM !== undefined && { accuracyM: input.accuracyM }),
        ...(input.mockLocationDetected !== undefined && {
          mockLocationDetected: input.mockLocationDetected,
        }),
        ...(input.deviceSignals !== undefined && {
          deviceSignals: input.deviceSignals,
        }),
      });
    }),

  checkOut: locumProcedure
    .input(attendanceInput)
    .mutation(async ({ ctx, input }) => {
      return checkOut(ctx.db, {
        bookingId: input.bookingId,
        actorId: ctx.user.id,
        location: input.location,
        ...(input.accuracyM !== undefined && { accuracyM: input.accuracyM }),
        ...(input.mockLocationDetected !== undefined && {
          mockLocationDetected: input.mockLocationDetected,
        }),
        ...(input.deviceSignals !== undefined && {
          deviceSignals: input.deviceSignals,
        }),
      });
    }),

  /** The locum's own record for a booking. */
  mine: locumProcedure
    .input(z.object({ bookingId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [booking] = await ctx.db
        .select({ locumId: bookings.locumId })
        .from(bookings)
        .where(eq(bookings.id, input.bookingId))
        .limit(1);

      if (!booking || booking.locumId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
      }

      return (await getAttendance(ctx.db, input.bookingId)) ?? null;
    }),

  /**
   * §10.0 — the hours-worked record a pharmacy hands to its own payroll.
   *
   * This is the entire extent of the platform's involvement in wages. It
   * reports when someone arrived and left and how far from the dispensary they
   * were; it deliberately does not multiply hours by a rate, because the moment
   * it produces a payable amount it starts to look like the labour broker
   * §10.0 exists to avoid being.
   */
  timesheet: managerProcedure
    .input(z.object({ shiftId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [owned] = await ctx.db
        .select({ id: shifts.id })
        .from(shifts)
        .innerJoin(
          pharmacyMembers,
          eq(pharmacyMembers.pharmacyId, shifts.pharmacyId),
        )
        .where(
          and(
            eq(shifts.id, input.shiftId),
            eq(pharmacyMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!owned) {
        // Indistinguishable from "does not exist", so this cannot enumerate
        // other pharmacies' shifts.
        throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found" });
      }

      const rows = await ctx.db
        .select({
          bookingId: bookings.id,
          bookingStatus: bookings.status,
          locumName: users.fullName,
          checkedInAt: checkIns.checkedInAt,
          checkedOutAt: checkIns.checkedOutAt,
          checkInDistanceM: checkIns.checkInDistanceM,
          checkOutDistanceM: checkIns.checkOutDistanceM,
          mockLocationDetected: checkIns.mockLocationDetected,
        })
        .from(bookings)
        .innerJoin(users, eq(users.id, bookings.locumId))
        .leftJoin(checkIns, eq(checkIns.bookingId, bookings.id))
        .where(
          and(
            eq(bookings.shiftId, input.shiftId),
            eq(bookings.status, "confirmed"),
          ),
        );

      return rows.map((row) => ({
        ...row,
        minutesWorked:
          row.checkedInAt && row.checkedOutAt
            ? Math.round(
                (row.checkedOutAt.getTime() - row.checkedInAt.getTime()) / 60_000,
              )
            : null,
        /*
         * Surfaced so a manager can see WHY a record might warrant a
         * conversation, without the platform adjudicating. §8 keeps these as
         * signals precisely because a false positive that voids a real
         * pharmacist's shift is worse than a missed spoof.
         */
        flags: [
          ...(row.mockLocationDetected ? ["mock_location"] : []),
          ...((row.checkInDistanceM ?? 0) > 1000 ? ["check_in_far_from_site"] : []),
          ...((row.checkOutDistanceM ?? 0) > 1000 ? ["check_out_far_from_site"] : []),
          ...(row.checkedInAt && !row.checkedOutAt ? ["no_check_out"] : []),
          ...(!row.checkedInAt ? ["no_attendance_record"] : []),
        ],
      }));
    }),
});

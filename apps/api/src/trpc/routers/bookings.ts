import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { bookings, locumProfiles, pharmacies, pharmacyMembers, shifts, users } from "@locum/db";
import {
  QUOTAS,
  cancelBooking,
  confirmBooking,
  formatShiftStart,
  isUniqueViolation,
  sendWhatsAppMessage,
  withIdempotency,
} from "@locum/core";
import {
  router,
  managerProcedure,
  locumProcedure,
  protectedProcedure,
  quota,
} from "../trpc";

export const bookingsRouter = router({
  /**
   * A locum applies to a shift.
   *
   * Idempotency-keyed: a locum tapping "apply" twice on a patchy connection
   * (the normal condition on a commute) must not create two requests. The
   * partial unique index on (shift_id, locum_id) would reject the duplicate
   * anyway, but that surfaces as a constraint error rather than the success
   * the user's first tap already earned.
   */
  applyToShift: locumProcedure
    .use(quota(QUOTAS.applyToShift))
    .input(
      z.object({
        shiftId: z.string().uuid(),
        idempotencyKey: z.string().min(8).max(255),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [profile] = await ctx.db
        .select({ verification: locumProfiles.verification })
        .from(locumProfiles)
        .where(eq(locumProfiles.userId, ctx.user.id))
        .limit(1);

      /*
       * §5 — the verified-vs-complete distinction is load-bearing here. The
       * platform's core promise to a manager is that registration was actually
       * checked, so an unverified locum cannot enter the booking flow at all.
       */
      if (profile?.verification !== "verified") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Your SAPC registration must be verified before you can apply",
        });
      }

      const outcome = await withIdempotency(
        ctx.db,
        {
          scope: "booking.create",
          key: input.idempotencyKey,
          payload: { shiftId: input.shiftId, locumId: ctx.user.id },
        },
        async () => {
          const [shift] = await ctx.db
            .select({ id: shifts.id, status: shifts.status })
            .from(shifts)
            .where(eq(shifts.id, input.shiftId))
            .limit(1);

          if (!shift || shift.status !== "open") {
            throw new TRPCError({
              code: "CONFLICT",
              message: "This shift is no longer open",
            });
          }

          /*
           * `bookings_one_live_request_per_locum` is a partial unique index:
           * one live application per locum per shift. It is the right place
           * for that rule — a check-then-insert would race two taps against
           * each other — but the violation it raises is a Postgres message,
           * and without this translation it reached the user verbatim as
           * "duplicate key value violates unique constraint
           * bookings_one_live_request_per_locum".
           *
           * That is not a hypothetical: it is what the web client displayed
           * the first time someone applied to a shift twice. A raw constraint
           * name is unreadable to a pharmacist, and it leaks the schema.
           */
          try {
            const [created] = await ctx.db
              .insert(bookings)
              .values({
                shiftId: input.shiftId,
                locumId: ctx.user.id,
                status: "requested",
              })
              .returning({ id: bookings.id });

            return { bookingId: created!.id };
          } catch (error) {
            if (isUniqueViolation(error, "bookings_one_live_request_per_locum")) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "You have already applied for this shift",
              });
            }
            throw error;
          }
        },
      );

      if (outcome.status === "in_flight") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That request is still being processed",
        });
      }

      return { ...outcome.result, replayed: outcome.status === "replayed" };
    }),

  /**
   * A manager confirms an applicant, filling the shift.
   *
   * The heavy lifting — row locking, the one-confirmed-per-shift invariant,
   * and the ownership check — lives in packages/core. This procedure is a thin
   * transport wrapper on purpose: the same call is made by the worker, and
   * duplicating the rules here would let the two drift.
   */
  confirm: managerProcedure
    .input(z.object({ bookingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await confirmBooking(ctx.db, {
        bookingId: input.bookingId,
        actorId: ctx.user.id,
      });

      /*
       * §11.2 — tells the locum they got the shift. `sendWhatsAppMessage`
       * never throws (every failure mode — no consent, quiet hours, a
       * rejected send — resolves to a SendOutcome and is logged to
       * whatsapp_message_log), so this cannot turn a successful confirmation
       * into a failed request; the booking is the transaction that matters,
       * the message is best-effort on top of it.
       */
      const [details] = await ctx.db
        .select({ pharmacyName: pharmacies.name, startsAt: shifts.startsAt })
        .from(shifts)
        .innerJoin(pharmacies, eq(pharmacies.id, shifts.pharmacyId))
        .where(eq(shifts.id, result.shiftId))
        .limit(1);

      if (details) {
        await sendWhatsAppMessage(
          ctx.db,
          { sender: ctx.whatsappSender },
          {
            type: "booking_confirmed",
            userId: result.locumId,
            variables: [
              details.pharmacyName,
              formatShiftStart(details.startsAt),
              `${ctx.config.DASHBOARD_BASE_URL}/bookings/${result.bookingId}`,
            ],
          },
        );
      }

      return result;
    }),

  /**
   * §9 — either side cancels a confirmed booking.
   *
   * Deliberately available to both, on `protectedProcedure` rather than a
   * role-scoped one: the domain service decides whether the caller is the
   * booked locum or a manager at the owning pharmacy, and refuses anyone else.
   * Splitting this into two role-gated procedures would duplicate that rule at
   * the edge and let the two drift.
   */
  cancel: protectedProcedure
    .input(
      z.object({
        bookingId: z.string().uuid(),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      cancelBooking(ctx.db, {
        bookingId: input.bookingId,
        actorId: ctx.user.id,
        ...(input.reason !== undefined && { reason: input.reason }),
      }),
    ),

  /**
   * Applicants for one of the manager's own shifts.
   *
   * Returns the locum's name and reliability signals — a manager legitimately
   * needs these to choose — but not their phone number or email. §10.1 is
   * explicit that a manager should never need to give out or receive a
   * personal number to complete a booking; all contact routes through the
   * platform sender.
   */
  listApplicants: managerProcedure
    .input(z.object({ shiftId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [owned] = await ctx.db
        .select({ shiftId: shifts.id })
        .from(shifts)
        .innerJoin(
          pharmacyMembers,
          eq(pharmacyMembers.pharmacyId, shifts.pharmacyId),
        )
        .where(
          and(eq(shifts.id, input.shiftId), eq(pharmacyMembers.userId, ctx.user.id)),
        )
        .limit(1);

      if (!owned) {
        // Same response whether the shift belongs to someone else or does not
        // exist — otherwise this enumerates other pharmacies' shift ids.
        throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found" });
      }

      return ctx.db
        .select({
          bookingId: bookings.id,
          status: bookings.status,
          requestedAt: bookings.requestedAt,
          locumId: bookings.locumId,
          fullName: users.fullName,
          verification: locumProfiles.verification,
          reliabilityScore: locumProfiles.reliabilityScore,
          completedShifts: locumProfiles.completedShifts,
          noShows: locumProfiles.noShows,
        })
        .from(bookings)
        .innerJoin(users, eq(users.id, bookings.locumId))
        .innerJoin(locumProfiles, eq(locumProfiles.userId, bookings.locumId))
        .where(eq(bookings.shiftId, input.shiftId));
    }),

  /** The calling locum's own bookings. */
  mine: locumProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        bookingId: bookings.id,
        status: bookings.status,
        shiftId: shifts.id,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        hourlyRateCents: shifts.hourlyRateCents,
      })
      .from(bookings)
      .innerJoin(shifts, eq(shifts.id, bookings.shiftId))
      .where(eq(bookings.locumId, ctx.user.id))
      .orderBy(shifts.startsAt);
  }),
});

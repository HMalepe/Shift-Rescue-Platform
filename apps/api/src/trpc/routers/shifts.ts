import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import {
  bookings,
  favouriteLocums,
  locumProfiles,
  pharmacies,
  pharmacyMembers,
  shifts,
} from "@locum/db";
import { QUOTAS, startLookingForLocum } from "@locum/core";
import { router, managerProcedure, locumProcedure, quota } from "../trpc";

const createShiftSchema = z
  .object({
    pharmacyId: z.string().uuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    hourlyRateCents: z.number().int().min(0),
    /** §10.1 — default reach is favourites only; radius is an explicit opt-in. */
    visibility: z.enum(["favourites_only", "radius"]).default("favourites_only"),
    radiusKm: z.number().int().positive().max(200).optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .refine((v) => v.visibility !== "radius" || v.radiusKm !== undefined, {
    message: "radiusKm is required when visibility is 'radius'",
    path: ["radiusKm"],
  });

export const shiftsRouter = router({
  /**
   * §12.3 Phase 3 — "Looking for a Locum".
   *
   * Runs ring 0 (the pharmacy's favourites) INLINE rather than enqueuing it.
   * The spec's framing is "the instant a manager toggles", and a manager who
   * presses the button and is told "we notified your six regulars" has been
   * given something; one told "we will get to it" has been given a promise.
   *
   * Later rings are not started here. They escalate through the worker, which
   * re-checks that the shift is still open before each one — by the time ring 2
   * is due the shift is usually filled, and that is the normal case.
   *
   * Quota'd like any other write. A toggle is cheap for the manager and
   * expensive for the platform: each one can cost twenty-five WhatsApp
   * messages, so toggling repeatedly is the most efficient way an authenticated
   * account has to spend §11.6's daily budget.
   */
  lookingForLocum: managerProcedure
    .use(quota(QUOTAS.lookingForLocum))
    .input(z.object({ shiftId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
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
        // Not found rather than forbidden: a manager probing other pharmacies'
        // shift IDs should not learn which ones exist.
        throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found" });
      }

      return startLookingForLocum(
        ctx.db,
        { sender: ctx.whatsappSender },
        { shiftId: input.shiftId },
      );
    }),

  /**
   * Post a shift.
   *
   * §10.1: the default audience is the pharmacy's saved regulars. Widening to
   * a radius is a separate, explicit choice — one of the two complaints that
   * came directly from live WhatsApp usage was that a post reaches everyone
   * whether the manager wants it to or not.
   */
  create: managerProcedure
    .input(createShiftSchema)
    .mutation(async ({ ctx, input }) => {
      const [membership] = await ctx.db
        .select({ pharmacyId: pharmacyMembers.pharmacyId })
        .from(pharmacyMembers)
        .where(
          and(
            eq(pharmacyMembers.pharmacyId, input.pharmacyId),
            eq(pharmacyMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not manage this pharmacy",
        });
      }

      const [pharmacy] = await ctx.db
        .select({ location: pharmacies.location })
        .from(pharmacies)
        .where(eq(pharmacies.id, input.pharmacyId))
        .limit(1);

      if (!pharmacy) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pharmacy not found" });
      }

      const [created] = await ctx.db
        .insert(shifts)
        .values({
          pharmacyId: input.pharmacyId,
          createdBy: ctx.user.id,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          hourlyRateCents: input.hourlyRateCents,
          visibility: input.visibility,
          status: "open",
          // Denormalised from the pharmacy so matching is a single-table scan.
          location: pharmacy.location,
          ...(input.radiusKm !== undefined && { radiusKm: input.radiusKm }),
          ...(input.notes !== undefined && { notes: input.notes }),
        })
        .returning({ id: shifts.id, status: shifts.status });

      return created!;
    }),

  /**
   * Open shifts visible to the calling locum.
   *
   * Visibility is resolved server-side and is the reason this is not a plain
   * "list open shifts" query: a favourites-only shift must be invisible to
   * everyone the manager did not save, or the §10.1 control is decorative.
   *
   * Returns no locum data at all, and only the pharmacy's trading identity —
   * §12.1 calls out scraping of personal data on browse endpoints as a
   * specific risk.
   */
  listOpenForMe: locumProcedure
    .use(quota(QUOTAS.browseShifts))
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [profile] = await ctx.db
        .select({
          baseLocation: locumProfiles.baseLocation,
          maxTravelKm: locumProfiles.maxTravelKm,
          verification: locumProfiles.verification,
        })
        .from(locumProfiles)
        .where(eq(locumProfiles.userId, ctx.user.id))
        .limit(1);

      if (!profile?.baseLocation) {
        // Without a base location there is no meaningful proximity ordering.
        return [];
      }

      const point = sql`ST_SetSRID(ST_MakePoint(${profile.baseLocation.lng}, ${profile.baseLocation.lat}), 4326)::geography`;

      /*
       * Two visibility paths in one query:
       *   - favourites_only: the locum must be in this pharmacy's saved list
       *   - radius: the locum must be inside the shift's advertised radius
       *
       * The radius is bounded by the locum's own maxTravelKm too, so a shift
       * advertising 50 km does not surface to someone who will not travel it.
       */
      const rows = await ctx.db
        .select({
          id: shifts.id,
          startsAt: shifts.startsAt,
          endsAt: shifts.endsAt,
          hourlyRateCents: shifts.hourlyRateCents,
          notes: shifts.notes,
          pharmacyName: pharmacies.name,
          suburb: pharmacies.suburb,
          city: pharmacies.city,
          distanceMetres: sql<number>`ST_Distance(${shifts.location}, ${point})::int`,
        })
        .from(shifts)
        .innerJoin(pharmacies, eq(pharmacies.id, shifts.pharmacyId))
        .where(
          and(
            eq(shifts.status, "open"),
            gt(shifts.startsAt, sql`now()`),
            sql`(
              (${shifts.visibility} = 'favourites_only' AND EXISTS (
                SELECT 1 FROM ${favouriteLocums}
                WHERE ${favouriteLocums.pharmacyId} = ${shifts.pharmacyId}
                  AND ${favouriteLocums.locumId} = ${ctx.user.id}
              ))
              OR
              (${shifts.visibility} = 'radius'
                AND ST_DWithin(${shifts.location}, ${point},
                    LEAST(${shifts.radiusKm}, ${profile.maxTravelKm}) * 1000)
              )
            )`,
          ),
        )
        .orderBy(sql`ST_Distance(${shifts.location}, ${point})`)
        .limit(input.limit);

      return rows;
    }),

  /**
   * The manager's own board: every shift belonging to a pharmacy they are a
   * member of, with how many people have applied.
   *
   * Scoped through `pharmacy_members` rather than `created_by`. A shift posted
   * by a colleague who is on leave still has to be manageable, and keying the
   * board to the creator is how a pharmacy ends up unable to confirm cover for
   * tomorrow because the person who posted it is away.
   *
   * The applicant count is a grouped subquery rather than a per-row query from
   * the page. A board of 30 shifts issuing 30 counts is the N+1 that turns a
   * fast page into a slow one the week the pharmacy gets busy.
   */
  mine: managerProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        /** Past shifts are excluded by default; the board is for what is next. */
        includePast: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: shifts.id,
          startsAt: shifts.startsAt,
          endsAt: shifts.endsAt,
          hourlyRateCents: shifts.hourlyRateCents,
          status: shifts.status,
          visibility: shifts.visibility,
          radiusKm: shifts.radiusKm,
          notes: shifts.notes,
          pharmacyId: pharmacies.id,
          pharmacyName: pharmacies.name,
          suburb: pharmacies.suburb,
        })
        .from(shifts)
        .innerJoin(pharmacies, eq(pharmacies.id, shifts.pharmacyId))
        .innerJoin(
          pharmacyMembers,
          eq(pharmacyMembers.pharmacyId, shifts.pharmacyId),
        )
        .where(
          and(
            eq(pharmacyMembers.userId, ctx.user.id),
            ...(input.includePast ? [] : [gt(shifts.endsAt, sql`now()`)]),
          ),
        )
        .orderBy(asc(shifts.startsAt))
        .limit(input.limit);

      if (rows.length === 0) return [];

      const counts = await ctx.db
        .select({
          shiftId: bookings.shiftId,
          applicants: count(bookings.id),
        })
        .from(bookings)
        .where(
          and(
            inArray(
              bookings.shiftId,
              rows.map((row) => row.id),
            ),
            inArray(bookings.status, ["requested", "confirmed"]),
          ),
        )
        .groupBy(bookings.shiftId);

      const byShift = new Map(counts.map((row) => [row.shiftId, Number(row.applicants)]));
      return rows.map((row) => ({ ...row, applicants: byShift.get(row.id) ?? 0 }));
    }),
});

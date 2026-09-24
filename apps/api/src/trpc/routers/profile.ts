import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { locumProfiles, pharmacies, pharmacyMembers, users } from "@locum/db";
import { claimRegistrationNumber, notifyNearbyManagers } from "@locum/core";
import { router, locumProcedure, managerProcedure, protectedProcedure } from "../trpc";

const coordinate = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/** E.164-ish. Deliberately permissive: ZA numbers arrive in several shapes. */
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ]{9,20}$/, "Enter a valid phone number");

export const profileRouter = router({
  /** The caller's own account. */
  me: protectedProcedure.query(async ({ ctx }) => {
    const [user] = await ctx.db
      .select({
        id: users.id,
        role: users.role,
        email: users.email,
        fullName: users.fullName,
        phone: users.phone,
        quietHoursStart: users.quietHoursStart,
        quietHoursEnd: users.quietHoursEnd,
        whatsappOptInAt: users.whatsappOptInAt,
        whatsappOptOutAt: users.whatsappOptOutAt,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    return user ?? null;
  }),

  updateAccount: protectedProcedure
    .input(
      z.object({
        fullName: z.string().trim().min(2).max(200).optional(),
        phone: phone.optional(),
        /** §4.4 — notifications inside quiet hours are queued to 07:00. */
        quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(users)
        .set({
          ...(input.fullName !== undefined && { fullName: input.fullName }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.quietHoursStart !== undefined && {
            quietHoursStart: input.quietHoursStart,
          }),
          ...(input.quietHoursEnd !== undefined && {
            quietHoursEnd: input.quietHoursEnd,
          }),
          updatedAt: new Date(),
        })
        .where(eq(users.id, ctx.user.id));

      return { ok: true };
    }),

  /**
   * §11.4 — WhatsApp consent, separate from the POPIA consent captured at
   * onboarding.
   *
   * Meta requires its own explicit opt-in, and a working opt-out. Kept as two
   * timestamps rather than one boolean so the audit trail shows when each
   * happened — "did this user consent, and when" is the question that gets
   * asked, not "do they currently".
   */
  setWhatsappConsent: protectedProcedure
    .input(z.object({ optIn: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      await ctx.db
        .update(users)
        .set(
          input.optIn
            ? { whatsappOptInAt: now, whatsappOptOutAt: null, updatedAt: now }
            : { whatsappOptOutAt: now, updatedAt: now },
        )
        .where(eq(users.id, ctx.user.id));

      return { optedIn: input.optIn };
    }),

  /** The locum's matching profile. */
  locum: locumProcedure.query(async ({ ctx }) => {
    const [profile] = await ctx.db
      .select()
      .from(locumProfiles)
      .where(eq(locumProfiles.userId, ctx.user.id))
      .limit(1);
    return profile ?? null;
  }),

  updateLocumProfile: locumProcedure
    .input(
      z.object({
        /** Home base for proximity matching — NOT live device location (§8). */
        baseLocation: coordinate.optional(),
        maxTravelKm: z.number().int().min(1).max(200).optional(),
        sapcNumber: z.string().trim().max(32).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ verification: locumProfiles.verification })
        .from(locumProfiles)
        .where(eq(locumProfiles.userId, ctx.user.id))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found" });
      }

      const result = await ctx.db.transaction(async (tx) => {
        let sapcNumber: string | undefined;
        if (input.sapcNumber !== undefined) {
          const [owner] = await tx
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, ctx.user.id))
            .limit(1);
          sapcNumber = await claimRegistrationNumber(tx, {
            email: owner!.email,
            number: input.sapcNumber,
            replace: true,
          });
        }

        /*
         * Changing the SAPC number after verification resets it.
         *
         * The verification attests to a specific registration number that a
         * human checked. Letting a verified locum silently swap it for another
         * would turn the platform's central promise into something they can
         * edit — which is the whole attack, and it needs no malware or stolen
         * credentials.
         */
        const resetsVerification =
          input.sapcNumber !== undefined &&
          sapcNumber !== undefined &&
          existing.verification === "verified";

        await tx
          .update(locumProfiles)
          .set({
            ...(input.baseLocation !== undefined && { baseLocation: input.baseLocation }),
            ...(input.maxTravelKm !== undefined && { maxTravelKm: input.maxTravelKm }),
            ...(sapcNumber !== undefined && { sapcNumber }),
            ...(resetsVerification && {
              verification: "complete_unverified" as const,
              verifiedAt: null,
              verifiedBy: null,
            }),
            updatedAt: new Date(),
          })
          .where(eq(locumProfiles.userId, ctx.user.id));

        return { ok: true as const, verificationReset: resetsVerification };
      });

      return result;
    }),

  /**
   * §5 — availability, and the lapse problem.
   *
   * "Available" is only useful if it is current: a manager acts on it, so a
   * stale flag is worse than no flag. Confirming availability stamps
   * `availabilityConfirmedAt`, which is what the nudge job reads to find
   * people whose status has gone quietly out of date.
   */
  setAvailability: locumProcedure
    .input(
      z.object({
        availableFrom: z.coerce.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      await ctx.db
        .update(locumProfiles)
        .set({
          availableFrom: input.availableFrom,
          availabilityConfirmedAt: now,
          updatedAt: now,
        })
        .where(eq(locumProfiles.userId, ctx.user.id));

      /*
       * The real-time half of the "N locums near you" nudge (§11 addendum):
       * going available right now, not scheduling a future date, is what
       * makes this worth telling a nearby pharmacy about immediately rather
       * than waiting for their own digest cadence. `sendWhatsAppMessage`
       * inside this never throws, so a notify failure cannot turn a
       * successful availability update into a failed request.
       */
      if (input.availableFrom !== null && input.availableFrom.getTime() <= now.getTime()) {
        await notifyNearbyManagers(
          ctx.db,
          { sender: ctx.whatsappSender, dashboardBaseUrl: ctx.config.DASHBOARD_BASE_URL },
          { locumId: ctx.user.id },
        );
      }

      return { availableFrom: input.availableFrom, confirmedAt: now };
    }),

  /** Pharmacies the calling manager belongs to. */
  myPharmacies: managerProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: pharmacies.id,
        name: pharmacies.name,
        tradingName: pharmacies.tradingName,
        addressLine: pharmacies.addressLine,
        suburb: pharmacies.suburb,
        city: pharmacies.city,
        province: pharmacies.province,
        postalCode: pharmacies.postalCode,
        location: pharmacies.location,
        verification: pharmacies.verification,
        isPrimary: pharmacyMembers.isPrimary,
      })
      .from(pharmacyMembers)
      .innerJoin(pharmacies, eq(pharmacies.id, pharmacyMembers.pharmacyId))
      .where(eq(pharmacyMembers.userId, ctx.user.id));
  }),

  updatePharmacy: managerProcedure
    .input(
      z.object({
        pharmacyId: z.string().uuid(),
        name: z.string().trim().min(2).max(200).optional(),
        tradingName: z.string().trim().max(200).optional(),
        addressLine: z.string().trim().min(3).max(500).optional(),
        suburb: z.string().trim().max(120).optional(),
        city: z.string().trim().max(120).optional(),
        postalCode: z.string().trim().max(10).optional(),
        /**
         * Moving the pharmacy moves where its shifts are matched from. Existing
         * shifts keep their own denormalised location deliberately — a shift
         * already advertised at one address should not silently relocate under
         * a locum who accepted it.
         */
        location: coordinate.optional(),
      }),
    )
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
        // Same shape as "does not exist": this must not confirm which
        // pharmacy ids are real.
        throw new TRPCError({ code: "NOT_FOUND", message: "Pharmacy not found" });
      }

      await ctx.db
        .update(pharmacies)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.tradingName !== undefined && { tradingName: input.tradingName }),
          ...(input.addressLine !== undefined && { addressLine: input.addressLine }),
          ...(input.suburb !== undefined && { suburb: input.suburb }),
          ...(input.city !== undefined && { city: input.city }),
          ...(input.postalCode !== undefined && { postalCode: input.postalCode }),
          ...(input.location !== undefined && { location: input.location }),
          updatedAt: new Date(),
        })
        .where(eq(pharmacies.id, input.pharmacyId));

      return { ok: true };
    }),
});

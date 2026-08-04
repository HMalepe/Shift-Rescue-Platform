import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { pharmacyMembers } from "@locum/db";
import { beginSubscribe, buildSubscribeRedirect } from "@locum/core";
import { router, managerProcedure } from "../trpc";

/**
 * §2 — the Payfast Subscribe flow, initiated from the dashboard.
 *
 * This mutation does the minimum the browser needs: prove the caller manages
 * the pharmacy, ensure a subscription row exists (creating one in `trialing`
 * if this is the pharmacy's first time here — see `beginSubscribe`'s
 * comment), and hand back a signed set of fields for an auto-submitting form
 * POST to Payfast's hosted checkout. Activation itself happens only once
 * Payfast's ITN confirms payment — see `payfast/itn-webhook.ts`.
 */
export const billingRouter = router({
  subscribe: managerProcedure
    .input(z.object({ pharmacyId: z.string().uuid() }))
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

      const { subscriptionId } = await beginSubscribe(ctx.db, {
        pharmacyId: input.pharmacyId,
        monthlyCents: ctx.config.SUBSCRIPTION_MONTHLY_CENTS,
      });

      if (
        !ctx.config.PAYFAST_MERCHANT_ID ||
        !ctx.config.PAYFAST_MERCHANT_KEY ||
        !ctx.config.PAYFAST_PASSPHRASE
      ) {
        // assertProductionReady should have stopped boot before this is ever
        // reachable in production. Fail loudly rather than sign a redirect
        // with an empty merchant id, which Payfast would simply reject.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Payment provider is not configured",
        });
      }

      // The manager's BROWSER goes back to the Vercel dashboard...
      const dashboardBase = ctx.config.DASHBOARD_BASE_URL.replace(/\/$/, "");
      // ...but Payfast's server-to-server ITN always comes to this API.
      const apiBase = ctx.config.PUBLIC_BASE_URL.replace(/\/$/, "");

      const redirect = buildSubscribeRedirect(
        {
          merchantId: ctx.config.PAYFAST_MERCHANT_ID,
          merchantKey: ctx.config.PAYFAST_MERCHANT_KEY,
          passphrase: ctx.config.PAYFAST_PASSPHRASE,
          ...(ctx.config.PAYFAST_PROCESS_URL !== undefined && {
            processUrl: ctx.config.PAYFAST_PROCESS_URL,
          }),
        },
        {
          subscriptionId,
          amountCents: ctx.config.SUBSCRIPTION_MONTHLY_CENTS,
          itemName: "Locum Planner subscription",
          returnUrl: `${dashboardBase}/billing/return`,
          cancelUrl: `${dashboardBase}/billing/cancel`,
          notifyUrl: `${apiBase}/webhooks/payfast/itn`,
        },
      );

      return redirect;
    }),
});

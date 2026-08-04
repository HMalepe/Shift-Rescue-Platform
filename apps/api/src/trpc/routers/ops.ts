import { z } from "zod";
import { getOpsDashboard } from "@locum/core";
import { router, adminProcedure } from "../trpc";

/**
 * §12.2 — the operations dashboard.
 *
 * `adminProcedure`, so it carries the MFA requirement §12.1 puts on admin
 * accounts. The payload is aggregate counts with no personal data in it, but
 * it is a complete picture of the business — how many pharmacies are
 * restricted for non-payment, how much is being collected, how many shifts go
 * unfilled — and that is competitive intelligence even without a single name
 * attached.
 */
export const opsRouter = router({
  dashboard: adminProcedure
    .input(
      z.object({
        /*
         * Bounded at a year. An unbounded window would let one request scan
         * every row in the busiest tables, which turns an admin page into an
         * accidental denial of service against the database serving bookings.
         */
        hours: z.number().int().min(1).max(24 * 365).default(24),
      }),
    )
    .query(async ({ ctx, input }) => getOpsDashboard(ctx.db, { hours: input.hours })),
});

import { z } from "zod";
import { getReputation, rateBooking, unratedBookingsFor } from "@locum/core";
import { router, protectedProcedure } from "../trpc";

/**
 * §7 — reputation.
 *
 * `protectedProcedure` throughout: a tier is two-sided, so both a manager
 * looking at a locum and a locum looking at a pharmacy hit the same
 * procedures. Narrowing by role would mean writing the participant rules twice
 * and letting the copies drift.
 *
 * Note what `of` does NOT accept: any way to ask for the underlying ratings,
 * scores, or rater identities. The whole §7 privacy design is in what
 * `getReputation` chooses to return, and an endpoint that handed back the raw
 * rows would route around it completely — the client could compute its own
 * average and show it, and every anonymisation control would be decoration.
 */
export const reputationRouter = router({
  /**
   * A subject's public reputation.
   *
   * Anyone signed in may ask. That is deliberate and it is safe: what comes
   * back is a coarse band or a withheld reason, both of which are already the
   * output of the anonymisation rules. Restricting it to counterparties would
   * suggest the payload were sensitive, which would be the wrong lesson to
   * teach about it.
   */
  of: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ ctx, input }) => getReputation(ctx.db, input.userId)),

  /** The caller's own, so they can see what a pharmacy sees. */
  mine: protectedProcedure.query(async ({ ctx }) =>
    getReputation(ctx.db, ctx.user.id),
  ),

  rate: protectedProcedure
    .input(
      z.object({
        bookingId: z.string().uuid(),
        score: z.number().int().min(1).max(5),
        comment: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      rateBooking(ctx.db, {
        bookingId: input.bookingId,
        raterId: ctx.user.id,
        score: input.score,
        ...(input.comment !== undefined && { comment: input.comment }),
      }),
    ),

  /** Shifts the caller has worked and not yet rated. Drives one prompt. */
  pending: protectedProcedure.query(async ({ ctx }) =>
    unratedBookingsFor(ctx.db, ctx.user.id),
  ),
});

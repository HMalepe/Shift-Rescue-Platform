import { z } from "zod";
import { listFlaggedMessages, postMessage, readThread } from "@locum/core";
import { router, protectedProcedure, adminProcedure } from "../trpc";

/**
 * §6 — in-app messaging between a pharmacy and a locum.
 *
 * All three procedures are thin. The gate, the flag and the projection all
 * live in `@locum/core`, which matters for the same reason the authorization
 * check on booking confirmation had to move there: anything enforced only in a
 * tRPC middleware is not enforced for the worker, a script, or the next
 * transport someone adds.
 *
 * `protectedProcedure` rather than `locumProcedure`/`managerProcedure`,
 * deliberately: a thread has exactly two sides and `postMessage` already
 * decides which of them the caller is. Narrowing by role here would mean
 * writing that same participant check twice, and the version in the router
 * would be the one that drifts.
 */
export const messagesRouter = router({
  post: protectedProcedure
    .input(
      z.object({
        bookingId: z.string().uuid(),
        /*
         * 2,000 characters. Long enough for anything anyone actually types
         * about a shift; short enough that the body column and the regex pass
         * over it stay bounded. The lower bound rejects an empty message,
         * which is a client bug rather than a thing a user meant.
         */
        body: z.string().min(1).max(2_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await postMessage(ctx.db, {}, {
        bookingId: input.bookingId,
        senderId: ctx.user.id,
        body: input.body,
      });

      /*
       * The flag is stripped from the response on purpose. Telling a sender
       * their message was flagged hands them a live oracle for the detector —
       * they can retype until it stops firing. §6's flags are for the admin
       * queue; the sender sees a message that sent, because it did.
       */
      return { id: result.id };
    }),

  thread: protectedProcedure
    .input(z.object({ bookingId: z.string().uuid() }))
    .query(async ({ ctx, input }) =>
      readThread(ctx.db, { bookingId: input.bookingId, readerId: ctx.user.id }),
    ),

  /**
   * §6/§14 — the human review queue.
   *
   * This is where flags become labels, and those labels are the only thing
   * that will ever turn the false-positive rate into a real number rather than
   * a property of whoever wrote the corpus.
   */
  flagged: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => listFlaggedMessages(ctx.db, input.limit)),
});

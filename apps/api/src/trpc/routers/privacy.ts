import { z } from "zod";
import { eraseSubject, exportSubjectData } from "@locum/core";
import { router, protectedProcedure, adminProcedure } from "../trpc";

/**
 * §10 — POPIA's access and erasure rights.
 *
 * ## Who may ask, and about whom
 *
 * A subject may export and erase THEMSELVES, with no id parameter — there is
 * deliberately no way to name someone else on these procedures. An
 * `exportSubjectData(userId)` endpoint reachable by any signed-in caller would
 * be a bulk personal-data extraction API wearing a compliance label, which is
 * a considerably worse outcome than having no export at all.
 *
 * Admins get the same two operations with an explicit subject, because a
 * written erasure request arriving by email has to be actionable by somebody.
 * Those carry MFA (§12.1) and land in the audit log naming the admin.
 */
export const privacyRouter = router({
  /** Everything held about the caller. */
  exportMine: protectedProcedure.query(async ({ ctx }) =>
    exportSubjectData(ctx.db, ctx.user.id),
  ),

  /**
   * Erase the caller's own account.
   *
   * Requires typing the confirmation phrase. Not theatre: this is irreversible
   * and, unlike almost everything else in the product, cannot be undone by an
   * admin afterwards — the data is genuinely gone. A single click is the wrong
   * interaction for that.
   */
  eraseMine: protectedProcedure
    .input(z.object({ confirmation: z.literal("ERASE MY ACCOUNT") }))
    .mutation(async ({ ctx }) =>
      eraseSubject(ctx.db, { subjectId: ctx.user.id, requestedBy: ctx.user.id }),
    ),

  /** For a written request handled by a human. */
  exportSubject: adminProcedure
    .input(z.object({ subjectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => exportSubjectData(ctx.db, input.subjectId)),

  eraseSubject: adminProcedure
    .input(
      z.object({
        subjectId: z.string().uuid(),
        confirmation: z.literal("ERASE THIS ACCOUNT"),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      eraseSubject(ctx.db, { subjectId: input.subjectId, requestedBy: ctx.user.id }),
    ),
});

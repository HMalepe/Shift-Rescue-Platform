import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { documents, locumProfiles } from "@locum/db";
import {
  createSignedUrl,
  listPendingLocums,
  listPendingPharmacies,
  listPendingReview,
  reviewDocument,
  reviewLocum,
  reviewPharmacy,
  uploadDocument,
  verificationHistory,
  MAX_DOCUMENT_BYTES,
} from "@locum/core";
import { router, adminProcedure, locumProcedure, protectedProcedure } from "../trpc";

/**
 * §5 / §12.1 — document upload and the admin verification queue.
 *
 * Every mutation that can change a verification status runs on
 * `adminProcedure`, which asserts the session actually carries the MFA claim
 * rather than trusting that login enforced it. §12.1 calls these accounts a
 * high-value target precisely because marking employment "verified" is the
 * platform's core promise to a manager.
 */
export const verificationRouter = router({
  /**
   * A locum uploads a document.
   *
   * The body arrives base64-encoded through tRPC's JSON transport. That is a
   * deliberate simplification for Phase 1 — it caps practical upload size and
   * costs ~33% overhead, so the S3 direct-upload path (browser PUTs to a
   * presigned URL, server records the key) should replace it before launch.
   * Recorded here rather than left implicit because the limit is small enough
   * to be mistaken for a bug later.
   */
  upload: locumProcedure
    .input(
      z.object({
        type: z.enum([
          "sapc_certificate",
          "identity_document",
          "payslip",
          "employment_letter",
        ]),
        // base64 of at most MAX_DOCUMENT_BYTES; 4/3 for the encoding overhead.
        contentBase64: z.string().max(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 1024),
        filename: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const body = Buffer.from(input.contentBase64, "base64");
      if (body.byteLength === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Empty upload" });
      }

      return uploadDocument(
        ctx.db,
        { storage: ctx.documentStorage, scanner: ctx.documentScanner },
        {
          userId: ctx.user.id,
          type: input.type,
          body,
          ...(input.filename !== undefined && { originalFilename: input.filename }),
        },
      );
    }),

  /** The locum's own documents. Never returns bytes — only a signed URL. */
  myDocuments: locumProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: documents.id,
        type: documents.type,
        mimeType: documents.detectedMimeType,
        sizeBytes: documents.sizeBytes,
        scan: documents.scan,
        reviewedAt: documents.reviewedAt,
        uploadedAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.userId, ctx.user.id));

    return rows.map((row) => ({
      ...row,
      // Only a clean document is retrievable at all.
      ...(row.scan === "clean"
        ? {
            download: createSignedUrl(row.id, ctx.user.id, ctx.config.AUTH_SECRET),
          }
        : { download: null }),
    }));
  }),

  /** Whether the caller is verified, and why not if not. */
  myStatus: protectedProcedure.query(async ({ ctx }) => {
    const [profile] = await ctx.db
      .select({
        verification: locumProfiles.verification,
        verifiedAt: locumProfiles.verifiedAt,
        sapcNumber: locumProfiles.sapcNumber,
        maxTravelKm: locumProfiles.maxTravelKm,
      })
      .from(locumProfiles)
      .where(eq(locumProfiles.userId, ctx.user.id))
      .limit(1);

    return profile ?? null;
  }),

  /** §12.1 — the admin review queue. */
  queue: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => listPendingReview(ctx.db, input.limit)),

  /**
   * Issues a short-lived, recipient-bound URL for an admin to view a document.
   *
   * Separate from the queue listing on purpose: the listing is browsed
   * routinely, and minting a URL for every row would scatter live links to ID
   * documents through logs and browser history. A reviewer asks for one when
   * they open a specific document.
   */
  documentUrl: adminProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [document] = await ctx.db
        .select({ id: documents.id, scan: documents.scan })
        .from(documents)
        .where(eq(documents.id, input.documentId))
        .limit(1);

      if (!document) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      }
      if (document.scan !== "clean") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This document did not pass its security scan",
        });
      }

      return createSignedUrl(document.id, ctx.user.id, ctx.config.AUTH_SECRET);
    }),

  /** Approve or reject. The decision is logged with the admin's identity. */
  review: adminProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        decision: z.enum(["verified", "rejected"]),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      reviewDocument(ctx.db, {
        documentId: input.documentId,
        adminId: ctx.user.id,
        decision: input.decision,
        ...(input.reason !== undefined && { reason: input.reason }),
      }),
    ),

  /** Every decision ever made about one locum. */
  history: adminProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ ctx, input }) => verificationHistory(ctx.db, input.userId)),

  /** Locums who are not yet verified, including those who never uploaded a document. */
  queueLocums: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => listPendingLocums(ctx.db, input.limit)),

  reviewLocum: adminProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        decision: z.enum(["verified", "rejected"]),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      reviewLocum(ctx.db, {
        userId: input.userId,
        adminId: ctx.user.id,
        decision: input.decision,
        ...(input.reason !== undefined && { reason: input.reason }),
      }),
    ),

  /**
   * §2's pharmacy SAPC number, checked directly rather than through a
   * document upload — see `packages/core/src/pharmacy-verification.ts` for
   * why that is a deliberately smaller flow than the locum one.
   */
  queuePharmacies: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => listPendingPharmacies(ctx.db, input.limit)),

  reviewPharmacy: adminProcedure
    .input(
      z.object({
        pharmacyId: z.string().uuid(),
        decision: z.enum(["verified", "rejected"]),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      reviewPharmacy(ctx.db, {
        pharmacyId: input.pharmacyId,
        adminId: ctx.user.id,
        decision: input.decision,
        ...(input.reason !== undefined && { reason: input.reason }),
      }),
    ),
});

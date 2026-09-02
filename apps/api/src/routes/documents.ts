import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { documents, type Database } from "@locum/db";
import { verifySignedUrl, type DocumentStorage } from "@locum/core";
import { resolveAuthenticatedUser } from "../trpc/context";
import type { Config } from "../config";

/**
 * §5 / §12.1 — actually serving a document.
 *
 * `verification.myDocuments` and `verification.documentUrl` (the tRPC router)
 * mint signed URLs pointing here, but until this route existed nothing on the
 * API answered them: the signing and verification logic was built and tested
 * in isolation while the one route that would call it was never wired up, so
 * no admin could ever actually open a SAPC certificate or ID document through
 * the product.
 *
 * A REST route rather than a tRPC procedure because tRPC's transport is JSON —
 * it has no way to stream document bytes back to a browser `<a href>` click.
 *
 * The signed URL IS the authorization, the same way an S3 presigned URL is:
 * `verification.documentUrl` already checked admin-or-owner before minting
 * one, and bound it to a specific presenter (`to`). This route's job is only
 * to check the signature, expiry and presenter match — re-deriving document
 * ownership here would be redundant with, and could drift from, the check
 * that ran when the URL was issued.
 */
export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { readonly db: Database; readonly config: Config; readonly documentStorage: DocumentStorage },
): void {
  const { db, config, documentStorage } = deps;

  app.get<{ Params: { id: string }; Querystring: { to?: string; expires?: string; sig?: string } }>(
    "/documents/:id",
    async (request, reply) => {
      // The presenting identity is who is CURRENTLY signed in, not whoever the
      // link was addressed to — that comparison is what verifySignedUrl makes
      // next, and it is the whole point of recipient binding: a link pasted
      // into a shared channel must be inert for anyone but the person it was
      // issued to.
      const user = await resolveAuthenticatedUser({ db, config }, request);
      if (!user) {
        return reply.code(401).send({ error: "unauthenticated" });
      }

      const verification = verifySignedUrl(
        {
          documentId: request.params.id,
          to: request.query.to,
          expires: request.query.expires,
          sig: request.query.sig,
        },
        config.AUTH_SECRET,
        user.id,
      );

      if (!verification.valid) {
        // 410 for an expired link (retryable — ask for a fresh one), 403 for
        // anything else. Neither reveals which check failed: a malformed
        // request and a forged signature should look identical from outside.
        const status = verification.reason === "expired" ? 410 : 403;
        return reply.code(status).send({ error: verification.reason });
      }

      const [document] = await db
        .select({
          storageKey: documents.storageKey,
          detectedMimeType: documents.detectedMimeType,
          scan: documents.scan,
        })
        .from(documents)
        .where(eq(documents.id, request.params.id))
        .limit(1);

      // Scanned-clean is re-checked here, not just at mint time: a document
      // under review when the URL was minted could since have been found
      // infected, and a signed URL's 5-minute lifetime is long enough for
      // that to matter.
      if (!document || document.scan !== "clean") {
        return reply.code(404).send({ error: "not_found" });
      }

      const body = await documentStorage.get(document.storageKey);
      if (!body) {
        request.log.error(
          { documentId: request.params.id, storageKey: document.storageKey },
          "document row exists with no matching object in storage",
        );
        return reply.code(404).send({ error: "not_found" });
      }

      reply.header("content-type", document.detectedMimeType);
      // inline, not attachment: a reviewer clicking a certificate expects it
      // to open, not to trigger a download-manager dialog.
      reply.header("content-disposition", "inline");
      // Documents are personal data behind a short-lived signed URL — a shared
      // or browser cache holding a copy after that URL expires defeats the
      // whole point of expiring it.
      reply.header("cache-control", "private, no-store");
      return reply.send(body);
    },
  );
}

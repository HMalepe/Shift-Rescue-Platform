import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  auditLog,
  documents,
  locumProfiles,
  users,
  type Database,
  type DocumentType,
} from "@locum/db";
import { DomainError } from "../errors";
import { detectMimeType, validateSize } from "./detect";
import type { DocumentScanner, DocumentStorage } from "./ports";

export interface UploadDocumentInput {
  readonly userId: string;
  readonly type: DocumentType;
  readonly body: Buffer;
  /** Client-supplied filename — used for nothing but logging. */
  readonly originalFilename?: string;
}

export interface UploadedDocument {
  readonly id: string;
  readonly detectedMimeType: string;
  readonly sizeBytes: number;
  readonly scan: "pending" | "clean" | "infected" | "scan_failed";
}

export interface DocumentDeps {
  readonly storage: DocumentStorage;
  readonly scanner: DocumentScanner;
}

/**
 * Accepts a document, but does not make it retrievable until it is clean.
 *
 * Order matters and is deliberate: detect type, then scan, and only then
 * store. §12.1 asks to "scan for malware before storage" — writing first and
 * scanning after would mean a window in which infected bytes sit in the bucket
 * with a database row pointing at them, which is precisely what an attacker
 * needs if any other code path ever serves by key.
 */
export async function uploadDocument(
  db: Database,
  deps: DocumentDeps,
  input: UploadDocumentInput,
): Promise<UploadedDocument> {
  const sizeProblem = validateSize(input.body.byteLength);
  if (sizeProblem && !sizeProblem.ok) {
    throw new DomainError("DOCUMENT_REJECTED", sizeProblem.reason);
  }

  // Type comes from the bytes, never from the client's Content-Type or the
  // filename extension — both are attacker-controlled.
  const detection = detectMimeType(input.body);
  if (!detection.ok) {
    throw new DomainError("DOCUMENT_REJECTED", detection.reason);
  }

  const verdict = await deps.scanner.scan(input.body);
  if (!verdict.clean) {
    /*
     * Recorded, not silently dropped. An account uploading malware is a signal
     * the admin queue should see, and §12.1 treats the verification path as a
     * social-engineering target — someone probing it is worth knowing about.
     * The bytes themselves are never stored.
     */
    const [rejected] = await db
      .insert(documents)
      .values({
        userId: input.userId,
        type: input.type,
        storageKey: "",
        detectedMimeType: detection.mimeType,
        sizeBytes: input.body.byteLength,
        sha256: sha256(input.body),
        scan: "infected",
        scannedAt: new Date(),
        scanDetail: verdict.detail,
      })
      .returning({ id: documents.id });

    await recordAudit(db, {
      actorId: input.userId,
      action: "document.rejected_infected",
      subjectType: "document",
      subjectId: rejected!.id,
      metadata: { detail: verdict.detail, filename: input.originalFilename },
    });

    throw new DomainError(
      "DOCUMENT_REJECTED",
      "This file was rejected by a security scan",
    );
  }

  const storageKey = `documents/${input.userId}/${randomUUID()}`;
  const stored = await deps.storage.put(
    storageKey,
    input.body,
    detection.mimeType,
  );

  const [created] = await db
    .insert(documents)
    .values({
      userId: input.userId,
      type: input.type,
      storageKey: stored.storageKey,
      detectedMimeType: detection.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: sha256(input.body),
      scan: "clean",
      scannedAt: new Date(),
    })
    .returning({ id: documents.id });

  /*
   * Uploading a document moves the locum from "incomplete" to
   * "complete_unverified" — never to "verified". §5 draws that line hard: only
   * a human admin checking the certificate against the SAPC registry can
   * verify, and the platform's entire promise to a manager rests on that
   * distinction being real.
   */
  if (input.type === "sapc_certificate") {
    await db
      .update(locumProfiles)
      .set({ verification: "complete_unverified", updatedAt: new Date() })
      .where(
        and(
          eq(locumProfiles.userId, input.userId),
          inArray(locumProfiles.verification, ["incomplete", "rejected"]),
        ),
      );
  }

  await recordAudit(db, {
    actorId: input.userId,
    action: "document.uploaded",
    subjectType: "document",
    subjectId: created!.id,
    metadata: { type: input.type, mimeType: detection.mimeType },
  });

  return {
    id: created!.id,
    detectedMimeType: detection.mimeType,
    sizeBytes: stored.sizeBytes,
    scan: "clean",
  };
}

export interface ReviewInput {
  readonly documentId: string;
  /** The admin making the call. Recorded against the decision (§12.1). */
  readonly adminId: string;
  readonly decision: "verified" | "rejected";
  readonly reason?: string;
}

/**
 * An admin approves or rejects a document, and with it the locum's
 * verification status.
 *
 * §12.1 singles this out: "an admin account with the power to mark employment
 * 'verified' is a high-value target; require MFA on all admin accounts, and
 * log every verification decision with the reviewing admin's identity". MFA is
 * enforced at the transport edge; the logging is here, so it happens whichever
 * path calls this.
 */
export async function reviewDocument(
  db: Database,
  input: ReviewInput,
): Promise<{ readonly documentId: string; readonly userId: string }> {
  return db.transaction(async (tx) => {
    const [document] = await tx
      .select({
        id: documents.id,
        userId: documents.userId,
        type: documents.type,
        scan: documents.scan,
        reviewedAt: documents.reviewedAt,
      })
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .limit(1);

    if (!document) {
      throw new DomainError("DOCUMENT_NOT_FOUND", "Document does not exist", {
        documentId: input.documentId,
      });
    }

    if (document.scan !== "clean") {
      // An admin should never be shown, let alone able to approve, a document
      // that failed its scan.
      throw new DomainError(
        "DOCUMENT_NOT_REVIEWABLE",
        `Cannot review a document whose scan status is '${document.scan}'`,
        { documentId: document.id, scan: document.scan },
      );
    }

    if (document.reviewedAt) {
      throw new DomainError(
        "DOCUMENT_ALREADY_REVIEWED",
        "This document has already been reviewed",
        { documentId: document.id },
      );
    }

    const now = new Date();

    await tx
      .update(documents)
      .set({ reviewedAt: now, reviewedBy: input.adminId })
      .where(eq(documents.id, document.id));

    if (document.type === "sapc_certificate") {
      await tx
        .update(locumProfiles)
        .set({
          verification: input.decision,
          verifiedAt: input.decision === "verified" ? now : null,
          verifiedBy: input.decision === "verified" ? input.adminId : null,
          updatedAt: now,
        })
        .where(eq(locumProfiles.userId, document.userId));
    }

    /*
     * The audit row is written inside the same transaction as the decision.
     * Logging afterwards would allow a state where employment is marked
     * verified with no record of who did it — which is the single fact §12.1
     * asks to be able to reconstruct.
     */
    await tx.insert(auditLog).values({
      actorId: input.adminId,
      action: `verification.${input.decision}`,
      subjectType: "locum_profile",
      subjectId: document.userId,
      metadata: JSON.stringify({
        documentId: document.id,
        documentType: document.type,
        reason: input.reason ?? null,
      }),
    });

    return { documentId: document.id, userId: document.userId };
  });
}

/** The admin review queue: clean, unreviewed documents, oldest first. */
export async function listPendingReview(db: Database, limit = 50) {
  return db
    .select({
      documentId: documents.id,
      userId: documents.userId,
      fullName: users.fullName,
      type: documents.type,
      mimeType: documents.detectedMimeType,
      sizeBytes: documents.sizeBytes,
      uploadedAt: documents.createdAt,
      currentStatus: locumProfiles.verification,
      sapcNumber: locumProfiles.sapcNumber,
    })
    .from(documents)
    .innerJoin(users, eq(users.id, documents.userId))
    .leftJoin(locumProfiles, eq(locumProfiles.userId, documents.userId))
    .where(and(eq(documents.scan, "clean"), isNull(documents.reviewedAt)))
    .orderBy(documents.createdAt)
    .limit(limit);
}

/** Every verification decision made about one locum, newest first. */
export async function verificationHistory(db: Database, userId: string) {
  return db
    .select({
      action: auditLog.action,
      actorId: auditLog.actorId,
      metadata: auditLog.metadata,
      at: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(eq(auditLog.subjectType, "locum_profile"), eq(auditLog.subjectId, userId)),
    )
    .orderBy(desc(auditLog.createdAt));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function recordAudit(
  db: Database,
  entry: {
    actorId: string;
    action: string;
    subjectType: string;
    subjectId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    metadata: JSON.stringify(entry.metadata),
  });
}

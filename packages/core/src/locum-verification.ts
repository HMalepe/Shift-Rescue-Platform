import { and, eq, isNull, ne } from "drizzle-orm";
import { auditLog, locumProfiles, users, type Database } from "@locum/db";
import { DomainError } from "./errors";

/**
 * Locums waiting for a human to check their SAPC number.
 *
 * The document queue only lists people who uploaded a certificate. A locum
 * who registered and stopped there never appeared, so an admin had nothing
 * to accept. This list is every locum who is not yet verified.
 */

export interface PendingLocum {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly sapcNumber: string | null;
  readonly verification: string;
  readonly maxTravelKm: number;
  readonly createdAt: Date;
}

export async function listPendingLocums(db: Database, limit = 50): Promise<PendingLocum[]> {
  return db
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      phone: users.phone,
      sapcNumber: locumProfiles.sapcNumber,
      verification: locumProfiles.verification,
      maxTravelKm: locumProfiles.maxTravelKm,
      createdAt: locumProfiles.createdAt,
    })
    .from(locumProfiles)
    .innerJoin(users, eq(users.id, locumProfiles.userId))
    .where(and(ne(locumProfiles.verification, "verified"), isNull(users.erasedAt)))
    .orderBy(locumProfiles.createdAt)
    .limit(limit);
}

export interface ReviewLocumInput {
  readonly userId: string;
  readonly adminId: string;
  readonly decision: "verified" | "rejected";
  readonly reason?: string;
}

export async function reviewLocum(
  db: Database,
  input: ReviewLocumInput,
): Promise<{ readonly userId: string }> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select({ userId: locumProfiles.userId, sapcNumber: locumProfiles.sapcNumber })
      .from(locumProfiles)
      .where(eq(locumProfiles.userId, input.userId))
      .limit(1);

    if (!profile) {
      throw new DomainError("SUBJECT_NOT_FOUND", "Locum profile not found", {
        userId: input.userId,
      });
    }
    if (!profile.sapcNumber) {
      throw new DomainError(
        "DOCUMENT_NOT_REVIEWABLE",
        "This locum has no SAPC registration number to check",
        { userId: input.userId },
      );
    }

    const now = new Date();
    await tx
      .update(locumProfiles)
      .set({
        verification: input.decision,
        verifiedAt: input.decision === "verified" ? now : null,
        verifiedBy: input.decision === "verified" ? input.adminId : null,
        updatedAt: now,
      })
      .where(eq(locumProfiles.userId, input.userId));

    await tx.insert(auditLog).values({
      actorId: input.adminId,
      action: `locum_verification.${input.decision}`,
      subjectType: "locum_profile",
      subjectId: input.userId,
      metadata: JSON.stringify({
        sapcNumber: profile.sapcNumber,
        reason: input.reason ?? null,
      }),
    });

    return { userId: input.userId };
  });
}

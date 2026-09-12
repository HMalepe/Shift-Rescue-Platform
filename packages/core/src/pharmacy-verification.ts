import { eq, ne } from "drizzle-orm";
import { auditLog, pharmacies, type Database } from "@locum/db";
import { DomainError } from "./errors";

/**
 * Verifying a pharmacy's SAPC registration.
 *
 * Deliberately not the document pipeline `packages/core/src/documents`
 * uses for a locum's own SAPC certificate: there is no requirement (yet) to
 * upload proof of a pharmacy's registration, only to record that an admin
 * checked the number against the SAPC register — same posture as everywhere
 * else in this codebase that says "reviewed, not verified" until there is
 * evidence to say more. `pharmacies` has no `verifiedAt`/`verifiedBy`
 * columns the way `locumProfiles` does; the audit log is the record of who
 * decided what and when, same mechanism §12.1 already requires for every
 * other verification decision.
 */

export interface PendingPharmacy {
  readonly pharmacyId: string;
  readonly name: string;
  readonly tradingName: string | null;
  readonly city: string;
  readonly suburb: string | null;
  readonly sapcPharmacyNumber: string | null;
  readonly verification: string;
  readonly createdAt: Date;
}

/** Every pharmacy not yet verified, oldest first. */
export async function listPendingPharmacies(
  db: Database,
  limit = 50,
): Promise<PendingPharmacy[]> {
  return db
    .select({
      pharmacyId: pharmacies.id,
      name: pharmacies.name,
      tradingName: pharmacies.tradingName,
      city: pharmacies.city,
      suburb: pharmacies.suburb,
      sapcPharmacyNumber: pharmacies.sapcPharmacyNumber,
      verification: pharmacies.verification,
      createdAt: pharmacies.createdAt,
    })
    .from(pharmacies)
    .where(ne(pharmacies.verification, "verified"))
    .orderBy(pharmacies.createdAt)
    .limit(limit);
}

export interface ReviewPharmacyInput {
  readonly pharmacyId: string;
  /** The admin making the call. Recorded against the decision (§12.1). */
  readonly adminId: string;
  readonly decision: "verified" | "rejected";
  readonly reason?: string;
}

export async function reviewPharmacy(
  db: Database,
  input: ReviewPharmacyInput,
): Promise<{ readonly pharmacyId: string }> {
  return db.transaction(async (tx) => {
    const [pharmacy] = await tx
      .select({ id: pharmacies.id })
      .from(pharmacies)
      .where(eq(pharmacies.id, input.pharmacyId))
      .limit(1);

    if (!pharmacy) {
      throw new DomainError("PHARMACY_NOT_FOUND", "Pharmacy not found", {
        pharmacyId: input.pharmacyId,
      });
    }

    await tx
      .update(pharmacies)
      .set({ verification: input.decision, updatedAt: new Date() })
      .where(eq(pharmacies.id, input.pharmacyId));

    // Same transaction as the decision, for the same reason reviewDocument's
    // audit row is: a verification with no record of who made it is the one
    // fact §12.1 asks to always be reconstructable.
    await tx.insert(auditLog).values({
      actorId: input.adminId,
      action: `pharmacy_verification.${input.decision}`,
      subjectType: "pharmacy",
      subjectId: input.pharmacyId,
      metadata: JSON.stringify({ reason: input.reason ?? null }),
    });

    return { pharmacyId: input.pharmacyId };
  });
}

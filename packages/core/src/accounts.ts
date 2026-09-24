import { eq, desc, isNull } from "drizzle-orm";
import {
  locumProfiles,
  pharmacies,
  pharmacyMembers,
  users,
  type Database,
} from "@locum/db";

/**
 * Every live account, with the verification state an admin can act on.
 *
 * The verification queues only show people who still need a decision, so an
 * empty queue looks like nobody registered. This list is the register itself.
 */
export interface AccountPharmacy {
  readonly pharmacyId: string;
  readonly name: string;
  readonly verification: string;
  readonly sapcPharmacyNumber: string | null;
}

export interface AccountRecord {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly phone: string | null;
  readonly createdAt: Date;
  readonly locumVerification: string | null;
  readonly sapcNumber: string | null;
  readonly pharmacies: AccountPharmacy[];
}

export async function listAccounts(db: Database): Promise<AccountRecord[]> {
  const people = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      phone: users.phone,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isNull(users.erasedAt))
    .orderBy(desc(users.createdAt));

  const locums = await db
    .select({
      userId: locumProfiles.userId,
      verification: locumProfiles.verification,
      sapcNumber: locumProfiles.sapcNumber,
    })
    .from(locumProfiles);

  const links = await db
    .select({
      userId: pharmacyMembers.userId,
      pharmacyId: pharmacies.id,
      name: pharmacies.name,
      verification: pharmacies.verification,
      sapcPharmacyNumber: pharmacies.sapcPharmacyNumber,
    })
    .from(pharmacyMembers)
    .innerJoin(pharmacies, eq(pharmacies.id, pharmacyMembers.pharmacyId));

  return people.map((person) => {
    const locum = locums.find((row) => row.userId === person.id);
    return {
      ...person,
      locumVerification: locum?.verification ?? null,
      sapcNumber: locum?.sapcNumber ?? null,
      pharmacies: links
        .filter((row) => row.userId === person.id)
        .map((row) => ({
          pharmacyId: row.pharmacyId,
          name: row.name,
          verification: row.verification,
          sapcPharmacyNumber: row.sapcPharmacyNumber,
        })),
    };
  });
}

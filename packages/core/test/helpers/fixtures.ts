import { createDatabase, type Database } from "@locum/db";
import * as s from "@locum/db/schema";
import { eq, inArray } from "drizzle-orm";

export const TEST_DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev";

export function connect() {
  return createDatabase({ url: TEST_DATABASE_URL, maxConnections: 20 });
}

const JOHANNESBURG = { lng: 28.0473, lat: -26.2041 } as const;

let counter = 0;
const unique = () => `${Date.now()}-${(counter += 1)}`;

export interface ShiftScenario {
  readonly managerId: string;
  readonly pharmacyId: string;
  readonly shiftId: string;
  readonly locumIds: readonly string[];
  readonly bookingIds: readonly string[];
}

/**
 * Builds one pharmacy, one open shift, and N locums each with a pending
 * booking request against that shift — the exact shape of the race the
 * concurrency gate exercises.
 *
 * Writes real rows rather than mocking. §0.1 is explicit that row-level
 * locking behaviour does not port from a different engine, so a mocked
 * database would verify nothing about the thing under test.
 */
export async function createContendedShift(
  db: Database,
  applicantCount: number,
): Promise<ShiftScenario> {
  const tag = unique();

  const [manager] = await db
    .insert(s.users)
    .values({
      role: "manager",
      email: `mgr-${tag}@test.invalid`,
      fullName: "Test Manager",
    })
    .returning({ id: s.users.id });

  const [pharmacy] = await db
    .insert(s.pharmacies)
    .values({
      name: `Test Pharmacy ${tag}`,
      addressLine: "1 Test Road",
      city: "Johannesburg",
      location: JOHANNESBURG,
    })
    .returning({ id: s.pharmacies.id });

  const [shift] = await db
    .insert(s.shifts)
    .values({
      pharmacyId: pharmacy!.id,
      createdBy: manager!.id,
      startsAt: new Date(Date.now() + 48 * 3_600_000),
      endsAt: new Date(Date.now() + 56 * 3_600_000),
      hourlyRateCents: 45_000,
      status: "open",
      location: JOHANNESBURG,
    })
    .returning({ id: s.shifts.id });

  const locumIds: string[] = [];
  const bookingIds: string[] = [];

  for (let i = 0; i < applicantCount; i += 1) {
    const [user] = await db
      .insert(s.users)
      .values({
        role: "locum",
        email: `locum-${tag}-${i}@test.invalid`,
        fullName: `Test Locum ${i}`,
      })
      .returning({ id: s.users.id });

    await db.insert(s.locumProfiles).values({
      userId: user!.id,
      verification: "verified",
      baseLocation: JOHANNESBURG,
    });

    const [booking] = await db
      .insert(s.bookings)
      .values({ shiftId: shift!.id, locumId: user!.id, status: "requested" })
      .returning({ id: s.bookings.id });

    locumIds.push(user!.id);
    bookingIds.push(booking!.id);
  }

  return {
    managerId: manager!.id,
    pharmacyId: pharmacy!.id,
    shiftId: shift!.id,
    locumIds,
    bookingIds,
  };
}

/** Removes only what a scenario created, so suites can run concurrently. */
export async function cleanupScenario(db: Database, scenario: ShiftScenario) {
  // Order matters: bookings reference shifts and locum_profiles; locum_profiles
  // and pharmacies reference users. Deleting users first would trip the
  // `onDelete: "restrict"` on bookings.locum_id.
  await db.delete(s.bookings).where(eq(s.bookings.shiftId, scenario.shiftId));
  await db.delete(s.shifts).where(eq(s.shifts.id, scenario.shiftId));
  await db
    .delete(s.locumProfiles)
    .where(inArray(s.locumProfiles.userId, [...scenario.locumIds]));
  await db.delete(s.pharmacies).where(eq(s.pharmacies.id, scenario.pharmacyId));
  await db
    .delete(s.users)
    .where(inArray(s.users.id, [scenario.managerId, ...scenario.locumIds]));
}

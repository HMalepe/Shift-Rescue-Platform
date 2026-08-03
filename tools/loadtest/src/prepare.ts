/**
 * Builds the fixtures the k6 run consumes, and writes a manifest.
 *
 * §0.3 requires the harness to be "parameterised by concurrency and dataset
 * size, runnable against staging by anyone on the team with one command".
 * Every knob below is an environment variable with a defensible default.
 *
 * Fixtures are written straight to the database rather than through the API.
 * Creating a few thousand rows over HTTP would take longer than the load test
 * itself and would trip the §12.1 login rate limits, measuring the limiter
 * rather than the thing under test.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import {
  createDatabase,
  favouriteLocums,
  locumProfiles,
  pharmacies,
  pharmacyMembers,
  bookings,
  sessions,
  shifts,
  users,
  type LngLat,
} from "@locum/db";
import { DEFAULT_AUTH_CONFIG, hashPassword, login } from "@locum/core";

const config = {
  databaseUrl: required("DATABASE_URL"),
  authSecret: process.env["AUTH_SECRET"] ?? "local-dev-auth-secret-at-least-32-chars",

  /** How many shifts are simultaneously contended. */
  contendedShifts: int("LOADTEST_CONTENDED_SHIFTS", 20),
  /**
   * Applicants racing for each of those shifts. This is the number that makes
   * the §12.3 row-locking gate meaningful: exactly one must win, no matter how
   * many race.
   */
  applicantsPerShift: int("LOADTEST_APPLICANTS_PER_SHIFT", 25),
  /**
   * §14: "configurable favorited-locum list sizes, defaulting to 10x projected
   * Month-6 numbers". This is the fan-out multiplier §12.3 warns about — the
   * proactive-matching burst is this wide per pharmacy.
   */
  favouritesPerPharmacy: int("LOADTEST_FAVOURITES", 300),
  /*
   * Shifts reserved for the fan-out, one manager each. More than a handful is
   * wasteful; fewer than the toggle rate means every toggle after the first
   * few hits an already-fanned-out shift and the burst measures the dedupe
   * rather than the fan-out.
   */
  fanoutShifts: int("LOADTEST_FANOUT_SHIFTS", 12),
  /** Locums browsing concurrently, exercising the proximity read path. */
  browsingLocums: int("LOADTEST_BROWSING_LOCUMS", 50),

  outDir: process.env["LOADTEST_OUT"] ?? join(process.cwd(), "results"),
} as const;

const PASSWORD = "loadtest-password-not-a-secret";
/** Every fixture row carries this marker so cleanup and verify can find them. */
export const LOADTEST_TAG = "loadtest.invalid";

const SANDTON: LngLat = { lng: 28.0567, lat: -26.1076 };

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

const { db, client } = createDatabase({
  url: config.databaseUrl,
  maxConnections: 20,
});

async function cleanupPreviousRun() {
  const stale = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${LOADTEST_TAG}`));

  if (stale.length === 0) return;
  const ids = stale.map((u) => u.id);

  const staleShifts = await db
    .select({ id: shifts.id })
    .from(shifts)
    .where(inArray(shifts.createdBy, ids));
  const shiftIds = staleShifts.map((s) => s.id);

  if (shiftIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.shiftId, shiftIds));
    await db.delete(shifts).where(inArray(shifts.id, shiftIds));
  }
  await db.delete(sessions).where(inArray(sessions.userId, ids));
  await db.delete(favouriteLocums).where(inArray(favouriteLocums.locumId, ids));
  await db.delete(pharmacyMembers).where(inArray(pharmacyMembers.userId, ids));
  await db.delete(locumProfiles).where(inArray(locumProfiles.userId, ids));

  const stalePharmacies = await db
    .select({ id: pharmacies.id })
    .from(pharmacies)
    .where(like(pharmacies.name, "loadtest-%"));
  for (const p of stalePharmacies) {
    await db.delete(favouriteLocums).where(eq(favouriteLocums.pharmacyId, p.id));
    await db.delete(pharmacyMembers).where(eq(pharmacyMembers.pharmacyId, p.id));
    await db.delete(pharmacies).where(eq(pharmacies.id, p.id));
  }
  await db.delete(users).where(inArray(users.id, ids));
  console.log(`  cleaned ${ids.length} rows from a previous run`);
}

async function main() {
  console.log("preparing load-test fixtures");
  console.log(
    `  ${config.contendedShifts} contended shifts x ${config.applicantsPerShift} applicants ` +
      `= ${config.contendedShifts * config.applicantsPerShift} racing confirmations`,
  );
  console.log(`  ${config.favouritesPerPharmacy} favourites/pharmacy (fan-out width)`);
  console.log(`  ${config.fanoutShifts} shifts reserved for the fan-out burst`);

  await cleanupPreviousRun();

  const passwordHash = await hashPassword(PASSWORD);
  const authConfig = { ...DEFAULT_AUTH_CONFIG, secret: config.authSecret };

  // ---- browsing locums (the fan-out read path) -------------------------
  /*
   * A phone number and a WhatsApp opt-in, because the fan-out will not select
   * anyone without them (§11.4).
   *
   * Missing from the first version of these fixtures, and the omission was
   * only exposed once the fan-out existed: the combined run reported
   * `fanout_offers_made: 0` while every threshold passed. The selection was
   * behaving correctly and the harness was measuring nothing — which is
   * exactly the "green run that proves nothing" the verifier now fails on.
   */
  const browsingLocumRows = Array.from({ length: config.browsingLocums }, (_, i) => ({
    role: "locum" as const,
    email: `lt-browse-${i}@${LOADTEST_TAG}`,
    fullName: `Loadtest Browser ${i}`,
    phone: `+2782${String(3_000_000 + i).slice(0, 7)}`,
    whatsappOptInAt: new Date(),
    passwordHash,
  }));
  const browsingLocums = await db
    .insert(users)
    .values(browsingLocumRows)
    .returning({ id: users.id, email: users.email });

  await db.insert(locumProfiles).values(
    browsingLocums.map((l) => ({
      userId: l.id,
      verification: "verified" as const,
      baseLocation: SANDTON,
      maxTravelKm: 30,
    })),
  );

  // ---- contended shifts ------------------------------------------------
  const manifestShifts: Array<{
    shiftId: string;
    managerToken: string;
    bookingIds: string[];
  }> = [];

  for (let i = 0; i < config.contendedShifts; i += 1) {
    const [manager] = await db
      .insert(users)
      .values({
        role: "manager",
        email: `lt-mgr-${i}@${LOADTEST_TAG}`,
        fullName: `Loadtest Manager ${i}`,
        passwordHash,
      })
      .returning({ id: users.id, email: users.email });

    const [pharmacy] = await db
      .insert(pharmacies)
      .values({
        name: `loadtest-pharmacy-${i}`,
        addressLine: "1 Load Road",
        city: "Johannesburg",
        location: SANDTON,
      })
      .returning({ id: pharmacies.id });

    await db.insert(pharmacyMembers).values({
      pharmacyId: pharmacy!.id,
      userId: manager!.id,
      isPrimary: true,
    });

    // Fan-out width: these are the locums a "looking for a locum" toggle
    // would notify first (§10.1, §12.3).
    const favouriteSlice = browsingLocums.slice(
      0,
      Math.min(config.favouritesPerPharmacy, browsingLocums.length),
    );
    if (favouriteSlice.length > 0) {
      await db
        .insert(favouriteLocums)
        .values(
          favouriteSlice.map((l) => ({ pharmacyId: pharmacy!.id, locumId: l.id })),
        );
    }

    const [shift] = await db
      .insert(shifts)
      .values({
        pharmacyId: pharmacy!.id,
        createdBy: manager!.id,
        startsAt: new Date(Date.now() + 72 * 3_600_000),
        endsAt: new Date(Date.now() + 80 * 3_600_000),
        hourlyRateCents: 45_000,
        status: "open",
        visibility: "radius",
        radiusKm: 30,
        location: SANDTON,
      })
      .returning({ id: shifts.id });

    // Applicants who will race to be confirmed.
    const applicantRows = Array.from(
      { length: config.applicantsPerShift },
      (_, j) => ({
        role: "locum" as const,
        email: `lt-app-${i}-${j}@${LOADTEST_TAG}`,
        fullName: `Loadtest Applicant ${i}-${j}`,
        passwordHash,
      }),
    );
    const applicants = await db
      .insert(users)
      .values(applicantRows)
      .returning({ id: users.id });

    await db.insert(locumProfiles).values(
      applicants.map((a) => ({
        userId: a.id,
        verification: "verified" as const,
        baseLocation: SANDTON,
        maxTravelKm: 30,
      })),
    );

    const created = await db
      .insert(bookings)
      .values(
        applicants.map((a) => ({
          shiftId: shift!.id,
          locumId: a.id,
          status: "requested" as const,
        })),
      )
      .returning({ id: bookings.id });

    const managerTokens = await login(db, authConfig, {
      email: manager!.email,
      password: PASSWORD,
    });

    manifestShifts.push({
      shiftId: shift!.id,
      managerToken: managerTokens.accessToken,
      bookingIds: created.map((b) => b.id),
    });
  }

  /*
   * ---- fan-out shifts --------------------------------------------------
   *
   * A SEPARATE set of shifts, with favourites and no applicants, used only by
   * the toggle scenario.
   *
   * They exist because the first combined run reported zero offers and the
   * reason was not a bug: the contention scenario confirms every contended
   * shift within the first second, `selectRing` correctly refuses to notify
   * anyone about a shift that is no longer open, and by the time the toggles
   * fired there was nothing left to fan out to.
   *
   * §12.3 wants both paths exercised AT THE SAME TIME, which is only possible
   * if the fan-out has shifts the contention scenario is not racing to fill.
   * One manager per shift, so the per-account toggle quota does not turn the
   * burst into a measurement of the rate limiter.
   */
  const fanoutShifts: Array<{ shiftId: string; managerToken: string }> = [];

  for (let i = 0; i < config.fanoutShifts; i += 1) {
    const [manager] = await db
      .insert(users)
      .values({
        role: "manager",
        email: `lt-fanmgr-${i}@${LOADTEST_TAG}`,
        fullName: `Loadtest Fanout Manager ${i}`,
        passwordHash,
      })
      .returning({ id: users.id, email: users.email });

    const [pharmacy] = await db
      .insert(pharmacies)
      .values({
        name: `loadtest-fanout-pharmacy-${i}`,
        addressLine: "2 Load Road",
        city: "Johannesburg",
        location: SANDTON,
      })
      .returning({ id: pharmacies.id });

    await db.insert(pharmacyMembers).values({
      pharmacyId: pharmacy!.id,
      userId: manager!.id,
      isPrimary: true,
    });

    const favouriteSlice = browsingLocums.slice(
      0,
      Math.min(config.favouritesPerPharmacy, browsingLocums.length),
    );
    if (favouriteSlice.length > 0) {
      await db
        .insert(favouriteLocums)
        .values(
          favouriteSlice.map((l) => ({ pharmacyId: pharmacy!.id, locumId: l.id })),
        );
    }

    const [shift] = await db
      .insert(shifts)
      .values({
        pharmacyId: pharmacy!.id,
        createdBy: manager!.id,
        startsAt: new Date(Date.now() + 96 * 3_600_000),
        endsAt: new Date(Date.now() + 104 * 3_600_000),
        hourlyRateCents: 45_000,
        status: "open",
        visibility: "radius",
        radiusKm: 30,
        location: SANDTON,
      })
      .returning({ id: shifts.id });

    const tokens = await login(db, authConfig, {
      email: manager!.email,
      password: PASSWORD,
    });

    fanoutShifts.push({ shiftId: shift!.id, managerToken: tokens.accessToken });
  }

  // ---- browsing tokens -------------------------------------------------
  const locumTokens: string[] = [];
  for (const locum of browsingLocums) {
    const tokens = await login(db, authConfig, {
      email: locum.email,
      password: PASSWORD,
    });
    locumTokens.push(tokens.accessToken);
  }

  mkdirSync(config.outDir, { recursive: true });
  const manifestPath = join(config.outDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        parameters: {
          contendedShifts: config.contendedShifts,
          applicantsPerShift: config.applicantsPerShift,
          favouritesPerPharmacy: config.favouritesPerPharmacy,
          browsingLocums: config.browsingLocums,
          fanoutShifts: config.fanoutShifts,
        },
        shifts: manifestShifts,
        fanoutShifts,
        locumTokens,
      },
      null,
      2,
    ),
  );

  console.log(`  manifest written to ${manifestPath}`);
  console.log(
    `  ${manifestShifts.length} shifts, ` +
      `${manifestShifts.reduce((n, s) => n + s.bookingIds.length, 0)} bookings, ` +
      `${locumTokens.length} browsing locums, ` +
      `${fanoutShifts.length} fan-out shifts`,
  );
}

try {
  await main();
} catch (error) {
  console.error("prepare failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}

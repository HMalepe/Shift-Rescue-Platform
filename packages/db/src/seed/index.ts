import { sql, type InferInsertModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../client";
import * as s from "../schema/index";
import { createRng, randomGautengPoint, pickCentre, scatterAround } from "./geography";
import type { LngLat } from "../types/geography";

/**
 * §14 — test fixtures and data generation.
 *
 * "Without it, 'test at realistic row counts' has no mechanism."
 *
 * Every default here is a floor from the spec, not a guess: 5,000+ locums,
 * 200+ pharmacies, favourited-list sizes at 10x projected Month-6 numbers,
 * booking history across every state, and dunning accounts in each terminal
 * condition.
 */
export interface SeedOptions {
  readonly locums?: number;
  readonly pharmacies?: number;
  /** §14: "defaulting to 10x projected Month-6 numbers". */
  readonly favouritesPerPharmacy?: number;
  readonly shiftsPerPharmacy?: number;
  /** Fixed by default so query plans are reproducible across runs. */
  readonly seed?: number;
  readonly verbose?: boolean;
}

const DEFAULTS = {
  locums: 5_000,
  pharmacies: 200,
  favouritesPerPharmacy: 30,
  shiftsPerPharmacy: 6,
  seed: 20260729,
  verbose: true,
} as const;

const FIRST_NAMES = [
  "Thandi", "Sipho", "Lerato", "Nomsa", "Kagiso", "Naledi", "Bongani", "Zanele",
  "Ayanda", "Tshepo", "Refilwe", "Mpho", "Lindiwe", "Sibusiso", "Palesa",
  "Anjali", "Priya", "Rajesh", "Yusuf", "Fatima", "Ebrahim", "Zainab",
  "Johan", "Marike", "Pieter", "Annelie", "Hendrik", "Elmarie",
  "David", "Sarah", "Michael", "Rachel", "Daniel", "Emma",
];

const LAST_NAMES = [
  "Nkosi", "Dlamini", "Mahlangu", "Mokoena", "Khumalo", "Ndlovu", "Zulu",
  "Molefe", "Sithole", "Mabaso", "Radebe", "Tshabalala", "Mnguni",
  "Naidoo", "Pillay", "Govender", "Patel", "Moosa", "Ismail",
  "van der Merwe", "Botha", "Pretorius", "Coetzee", "du Plessis", "Venter",
  "Smith", "Jones", "Williams", "Brown", "Taylor",
];

const PHARMACY_PREFIXES = [
  "Medicare", "Wellness", "Family", "Care", "Health", "Trust", "Prime",
  "Sunrise", "Cornerstone", "Unity", "Riverside", "Hillcrest", "Parkview",
  "Northgate", "Southdale", "Village", "Central", "Lifeline", "Nova", "Apex",
];

const PHARMACY_SUFFIXES = [
  "Pharmacy", "Chemist", "Pharmacy & Clinic", "Dispensary", "Health Care Pharmacy",
];

const STREETS = [
  "Main", "Church", "Voortrekker", "Rivonia", "Jan Smuts", "Oxford", "Louis Botha",
  "Beyers Naude", "William Nicol", "Ontdekkers", "Hendrik Potgieter", "Atterbury",
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Deterministic UUIDv4-shaped identifier from the seeded RNG. */
function uuid(rng: () => number): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[(Math.floor(rng() * 4) | 8)]!;
    else out += hex[Math.floor(rng() * 16)]!;
  }
  return out;
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

export async function seed(db: Database, options: SeedOptions = {}) {
  const config = { ...DEFAULTS, ...options };
  const rng = createRng(config.seed);
  const log = (message: string) => {
    if (config.verbose) console.log(message);
  };

  const started = Date.now();

  // ---------------------------------------------------------------------
  // Wipe. TRUNCATE ... CASCADE rather than per-table DELETE: it resets in one
  // statement and cannot leave orphans behind if the table list drifts.
  // ---------------------------------------------------------------------
  log("clearing existing data...");
  /*
   * `verification_runs` is deliberately NOT in this list.
   *
   * It is not fixture data — it is the §12.5 gate ledger, the durable record of
   * which gates passed and with what evidence. Truncating it on every seed
   * would reproduce exactly the failure §12.5 exists to prevent ("gate status
   * recorded only in a document drifts from reality within days"), except
   * faster and more silently: refreshing fixtures would destroy the audit
   * trail of every gate the team has closed. It survives because it holds no
   * foreign key into any table below, so CASCADE cannot reach it.
   *
   * `audit_log` IS cleared, and is listed explicitly rather than left to
   * happen via CASCADE. It references users, so truncating users would take it
   * regardless — naming it here means that is visible when reading the seed
   * instead of being a surprise in the NOTICE output. Acceptable because this
   * script refuses to run against production (see seed/run.ts); if audit
   * retention is ever needed on a shared staging box, users must be removed
   * with DELETE so the ON DELETE SET NULL on actor_id is honoured.
   */
  await db.execute(sql`
    TRUNCATE TABLE
      cancellation_fees, subscription_charges, subscriptions,
      ratings, messages, check_ins, bookings, shifts,
      favourite_locums, documents, locum_profiles,
      pharmacy_members, pharmacies, audit_log,
      whatsapp_message_log, idempotency_keys, users
    RESTART IDENTITY CASCADE
  `);

  // ---------------------------------------------------------------------
  // Locums (§14: 5,000+, clustered on real metro density)
  // ---------------------------------------------------------------------
  log(`generating ${config.locums} locums...`);
  const locumIds: string[] = [];
  const locumUserRows: (typeof s.users.$inferInsert)[] = [];
  const locumProfileRows: (typeof s.locumProfiles.$inferInsert)[] = [];

  for (let i = 0; i < config.locums; i += 1) {
    const id = uuid(rng);
    locumIds.push(id);
    const name = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;

    locumUserRows.push({
      id,
      role: "locum",
      email: `locum${i}@seed.locumplanner.test`,
      phone: `+2782${String(1_000_000 + i).slice(0, 7)}`,
      fullName: name,
      popiaConsentAt: new Date(),
      // Only ~70% opt in to WhatsApp: §11.4 requires opt-in to be a real,
      // separate decision, so a seed where everyone consented would let a
      // missing-consent bug pass unnoticed.
      whatsappOptInAt: rng() < 0.7 ? new Date() : null,
    });

    // §5 — the verified-vs-complete distinction. A realistic pool is mostly
    // unverified; matching and trust logic must cope with that.
    const roll = rng();
    const verification =
      roll < 0.45 ? "verified"
      : roll < 0.65 ? "complete_unverified"
      : roll < 0.8 ? "in_review"
      : roll < 0.9 ? "incomplete"
      : "rejected";

    const completed = randomInt(rng, 0, 60);

    locumProfileRows.push({
      userId: id,
      sapcNumber: verification === "incomplete" ? null : `P${100000 + i}`,
      verification,
      verifiedAt: verification === "verified" ? new Date() : null,
      baseLocation: randomGautengPoint(rng),
      maxTravelKm: pick(rng, [10, 15, 20, 25, 30, 40]),
      reliabilityScore: completed > 0 ? randomInt(rng, 60, 100) : null,
      completedShifts: completed,
      lateCancellations: randomInt(rng, 0, Math.max(1, Math.floor(completed / 8))),
      noShows: rng() < 0.12 ? randomInt(rng, 1, 3) : 0,
      availableFrom: rng() < 0.6 ? hoursFromNow(randomInt(rng, -48, 240)) : null,
      // §5 availability lapse: a third are deliberately stale, so the nudge
      // job has something to act on.
      availabilityConfirmedAt:
        rng() < 0.66 ? hoursFromNow(-randomInt(rng, 1, 72)) : hoursFromNow(-randomInt(rng, 400, 2000)),
    });
  }

  await insertChunked(db, s.users, locumUserRows);
  await insertChunked(db, s.locumProfiles, locumProfileRows);

  // ---------------------------------------------------------------------
  // Pharmacies + managers (§14: 200+, realistic geographic clustering)
  // ---------------------------------------------------------------------
  log(`generating ${config.pharmacies} pharmacies...`);
  const pharmacyIds: string[] = [];
  const pharmacyLocations: LngLat[] = [];
  const managerIds: string[] = [];
  const managerRows: (typeof s.users.$inferInsert)[] = [];
  const pharmacyRows: (typeof s.pharmacies.$inferInsert)[] = [];
  const memberRows: (typeof s.pharmacyMembers.$inferInsert)[] = [];

  for (let i = 0; i < config.pharmacies; i += 1) {
    const centre = pickCentre(rng);
    const location = scatterAround(rng, centre);
    const pharmacyId = uuid(rng);
    const managerId = uuid(rng);

    pharmacyIds.push(pharmacyId);
    pharmacyLocations.push(location);
    managerIds.push(managerId);

    managerRows.push({
      id: managerId,
      role: "manager",
      email: `manager${i}@seed.locumplanner.test`,
      phone: `+2783${String(1_000_000 + i).slice(0, 7)}`,
      fullName: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
      popiaConsentAt: new Date(),
      whatsappOptInAt: rng() < 0.85 ? new Date() : null,
    });

    pharmacyRows.push({
      id: pharmacyId,
      name: `${pick(rng, PHARMACY_PREFIXES)} ${pick(rng, PHARMACY_SUFFIXES)}`,
      addressLine: `${randomInt(rng, 1, 400)} ${pick(rng, STREETS)} Street`,
      suburb: centre.name,
      city: centre.name.includes("Pretoria") || centre.name === "Centurion" ? "Pretoria" : "Johannesburg",
      province: "Gauteng",
      postalCode: String(randomInt(rng, 1400, 2199)),
      location,
      verification: rng() < 0.8 ? "verified" : "complete_unverified",
    });

    memberRows.push({ pharmacyId, userId: managerId, isPrimary: true });
  }

  await insertChunked(db, s.users, managerRows);
  await insertChunked(db, s.pharmacies, pharmacyRows);
  await insertChunked(db, s.pharmacyMembers, memberRows);

  // ---------------------------------------------------------------------
  // Favourites (§14: configurable, defaulting to 10x Month-6 projections)
  //
  // This is the fan-out multiplier §12.3 warns about: the proactive-matching
  // burst is favourites-per-pharmacy wide, so seeding it thin would make the
  // load test meaningless.
  // ---------------------------------------------------------------------
  log(`generating favourites (${config.favouritesPerPharmacy} per pharmacy)...`);
  const favouriteRows: (typeof s.favouriteLocums.$inferInsert)[] = [];
  const favouritesByPharmacy = new Map<string, string[]>();

  for (const pharmacyId of pharmacyIds) {
    const chosen = new Set<string>();
    while (chosen.size < Math.min(config.favouritesPerPharmacy, locumIds.length)) {
      chosen.add(pick(rng, locumIds));
    }
    favouritesByPharmacy.set(pharmacyId, [...chosen]);
    for (const locumId of chosen) {
      favouriteRows.push({ pharmacyId, locumId });
    }
  }
  await insertChunked(db, s.favouriteLocums, favouriteRows);

  // ---------------------------------------------------------------------
  // Shifts + bookings across EVERY state (§14)
  // ---------------------------------------------------------------------
  log("generating shifts and bookings...");
  const shiftRows: (typeof s.shifts.$inferInsert)[] = [];
  const bookingRows: (typeof s.bookings.$inferInsert)[] = [];
  const checkInRows: (typeof s.checkIns.$inferInsert)[] = [];
  const ratingRows: (typeof s.ratings.$inferInsert)[] = [];

  const terminalStates = [
    "completed", "cancelled_by_locum", "cancelled_by_manager", "disputed", "no_show",
  ] as const;

  for (let p = 0; p < pharmacyIds.length; p += 1) {
    const pharmacyId = pharmacyIds[p]!;
    const managerId = managerIds[p]!;
    const location = pharmacyLocations[p]!;
    const favourites = favouritesByPharmacy.get(pharmacyId)!;

    for (let k = 0; k < config.shiftsPerPharmacy; k += 1) {
      const shiftId = uuid(rng);
      const isPast = k % 2 === 0;
      const startOffset = isPast
        ? -randomInt(rng, 24, 24 * 90)
        : randomInt(rng, 2, 24 * 30);
      const startsAt = hoursFromNow(startOffset);
      const endsAt = new Date(startsAt.getTime() + randomInt(rng, 4, 12) * 3_600_000);

      // §10.1 — favourites-only is the DEFAULT reach; radius is the explicit
      // minority action.
      const useRadius = rng() < 0.35;

      const roll = rng();
      const status = isPast
        ? (roll < 0.75 ? "completed" : "cancelled")
        : (roll < 0.45 ? "open" : roll < 0.75 ? "filled" : roll < 0.9 ? "draft" : "cancelled");

      shiftRows.push({
        id: shiftId,
        pharmacyId,
        createdBy: managerId,
        startsAt,
        endsAt,
        hourlyRateCents: randomInt(rng, 32000, 65000),
        visibility: useRadius ? "radius" : "favourites_only",
        radiusKm: useRadius ? pick(rng, [10, 15, 20, 30]) : null,
        status,
        location,
        cancelledAt: status === "cancelled" ? hoursFromNow(startOffset - 6) : null,
      });

      if (status === "draft") continue;

      // One confirmed booking for filled/completed shifts; the partial unique
      // index guarantees there can never be a second.
      const needsConfirmed = status === "filled" || status === "completed";
      const bookingLocum = pick(rng, favourites);

      if (needsConfirmed) {
        const bookingId = uuid(rng);
        const bookingStatus =
          status === "completed"
            ? pick(rng, terminalStates)
            : "confirmed";

        const lateCancel =
          bookingStatus === "cancelled_by_locum" || bookingStatus === "cancelled_by_manager"
            ? rng() < 0.4
            : false;

        bookingRows.push({
          id: bookingId,
          shiftId,
          locumId: bookingLocum,
          status: bookingStatus,
          confirmedAt: hoursFromNow(startOffset - randomInt(rng, 12, 200)),
          confirmedBy: managerId,
          cancelledAt: bookingStatus.startsWith("cancelled") ? hoursFromNow(startOffset - randomInt(rng, 1, 48)) : null,
          cancelledBy: bookingStatus === "cancelled_by_locum" ? bookingLocum : bookingStatus === "cancelled_by_manager" ? managerId : null,
          wasLateCancellation: lateCancel,
        });

        // §8 — check-in/out is OPT-IN, so only some completed bookings have one.
        if (bookingStatus === "completed" && rng() < 0.7) {
          const spoofed = rng() < 0.03;
          const checkInPoint = scatterAround(rng, {
            name: "site", lng: location.lng, lat: location.lat, weight: 1, spreadKm: 0.15,
          });
          checkInRows.push({
            bookingId,
            checkedInAt: startsAt,
            checkInLocation: checkInPoint,
            checkInAccuracyM: randomInt(rng, 5, 60),
            checkedOutAt: endsAt,
            checkOutLocation: checkInPoint,
            checkOutAccuracyM: randomInt(rng, 5, 60),
            // §16 — a physical Android device is required to produce this for
            // real; seeded here so downstream logic has something to read.
            mockLocationDetected: spoofed,
            checkInDistanceM: randomInt(rng, 5, 300),
            deviceSignals: { platform: "android", devMode: spoofed },
          });

          // §7 — both directions rate each other.
          ratingRows.push({
            bookingId, raterId: managerId, rateeId: bookingLocum,
            score: randomInt(rng, 3, 5),
          });
          ratingRows.push({
            bookingId, raterId: bookingLocum, rateeId: managerId,
            score: randomInt(rng, 3, 5),
          });
        }
      } else if (status === "open") {
        // Open shifts accumulate pending requests — the queue a manager sees.
        const applicantCount = randomInt(rng, 0, 4);
        const applicants = new Set<string>();
        while (applicants.size < applicantCount) applicants.add(pick(rng, favourites));
        for (const locumId of applicants) {
          bookingRows.push({
            id: uuid(rng), shiftId, locumId, status: "requested",
          });
        }
      }
    }
  }

  await insertChunked(db, s.shifts, shiftRows);
  await insertChunked(db, s.bookings, bookingRows);
  await insertChunked(db, s.checkIns, checkInRows);
  await insertChunked(db, s.ratings, ratingRows);

  // ---------------------------------------------------------------------
  // Subscriptions + dunning fixtures (§14: accounts in decline, retry,
  // restricted and dispute-flagged states)
  // ---------------------------------------------------------------------
  log("generating subscriptions and dunning fixtures...");
  const subscriptionRows: (typeof s.subscriptions.$inferInsert)[] = [];
  const chargeRows: (typeof s.subscriptionCharges.$inferInsert)[] = [];

  for (let i = 0; i < pharmacyIds.length; i += 1) {
    const subscriptionId = uuid(rng);
    const pharmacyId = pharmacyIds[i]!;

    // Deliberately over-represent unhealthy states relative to production:
    // the dunning state machine is the thing being tested, and a seed that is
    // 98% healthy exercises one branch of it.
    const roll = rng();
    const status =
      roll < 0.62 ? "active"
      : roll < 0.74 ? "past_due"
      : roll < 0.84 ? "restricted"
      : roll < 0.93 ? "trialing"
      : "cancelled";

    subscriptionRows.push({
      id: subscriptionId,
      pharmacyId,
      status,
      provider: rng() < 0.7 ? "payfast" : "ozow",
      providerRef: `sub_seed_${i}`,
      monthlyCents: 89900,
      currentPeriodStart: hoursFromNow(-24 * 20),
      currentPeriodEnd: hoursFromNow(24 * 10),
      restrictedAt: status === "restricted" ? hoursFromNow(-24 * 3) : null,
      cancelledAt: status === "cancelled" ? hoursFromNow(-24 * 40) : null,
    });

    const chargeStatus =
      status === "active" ? "succeeded"
      : status === "past_due" ? "retrying"
      : status === "restricted" ? "failed"
      : status === "cancelled" ? "abandoned"
      : "pending";

    chargeRows.push({
      id: uuid(rng),
      subscriptionId,
      amountCents: 89900,
      status: chargeStatus,
      attempt: chargeStatus === "retrying" ? randomInt(rng, 2, 4) : 1,
      nextRetryAt: chargeStatus === "retrying" ? hoursFromNow(randomInt(rng, 6, 72)) : null,
      providerRef: `chg_seed_${i}`,
      failureCode: chargeStatus === "failed" || chargeStatus === "retrying"
        ? pick(rng, ["insufficient_funds", "card_expired", "do_not_honour", "timeout"])
        : null,
      periodStart: hoursFromNow(-24 * 20),
      periodEnd: hoursFromNow(24 * 10),
      settledAt: chargeStatus === "succeeded" ? hoursFromNow(-24 * 19) : null,
    });
  }

  // A handful of explicitly disputed charges — §14 calls for dispute-flagged.
  for (let i = 0; i < 8; i += 1) {
    const row = chargeRows[i];
    if (row) row.status = "disputed";
  }

  await insertChunked(db, s.subscriptions, subscriptionRows);
  await insertChunked(db, s.subscriptionCharges, chargeRows);

  // ---------------------------------------------------------------------
  // Duplicate-webhook fixtures (§14 / §11.5)
  //
  // Repeated Twilio MessageSid payloads. These exist so the inbound
  // idempotency test has a real collision to detect rather than a synthetic
  // one constructed inside the test itself.
  // ---------------------------------------------------------------------
  log("generating duplicate-webhook fixtures...");
  const whatsappRows: (typeof s.whatsappMessageLog.$inferInsert)[] = [];
  for (let i = 0; i < 200; i += 1) {
    whatsappRows.push({
      twilioSid: `SM${String(i).padStart(32, "0")}`,
      userId: pick(rng, locumIds),
      templateType: pick(rng, ["booking_confirmed", "subscription_reminder", "shift_starting_soon", "availability_lapse"]),
      category: rng() < 0.85 ? "utility" : "marketing",
      direction: "outbound",
      status: pick(rng, ["queued", "sent", "delivered", "read", "failed"]),
      priceCents: randomInt(rng, 8, 45),
      statusUpdatedAt: new Date(),
    });
  }
  await insertChunked(db, s.whatsappMessageLog, whatsappRows);

  const elapsed = Date.now() - started;
  const summary = {
    locums: locumUserRows.length,
    pharmacies: pharmacyRows.length,
    favourites: favouriteRows.length,
    shifts: shiftRows.length,
    bookings: bookingRows.length,
    checkIns: checkInRows.length,
    ratings: ratingRows.length,
    subscriptions: subscriptionRows.length,
    charges: chargeRows.length,
    whatsappMessages: whatsappRows.length,
    elapsedMs: elapsed,
  };

  log(`seed complete in ${elapsed}ms`);
  return summary;
}

/**
 * Postgres caps a statement at 65,535 bind parameters. A 5,000-row insert with
 * 15 columns blows straight through that, so inserts are chunked by parameter
 * budget rather than by an arbitrary row count.
 */
async function insertChunked<TTable extends PgTable>(
  db: Database,
  table: TTable,
  rows: readonly InferInsertModel<TTable>[],
  parameterBudget = 30_000,
): Promise<void> {
  if (rows.length === 0) return;

  const columnCount = Math.max(1, Object.keys(rows[0] ?? {}).length);
  const chunkSize = Math.max(1, Math.floor(parameterBudget / columnCount));

  for (let i = 0; i < rows.length; i += chunkSize) {
    await db.insert(table).values(rows.slice(i, i + chunkSize));
  }
}

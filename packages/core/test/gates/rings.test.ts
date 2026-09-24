import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  LAST_RING,
  MAX_PER_RING,
  RING_BANDS_KM,
  nextRingDueAt,
  selectRing,
} from "../../src/matching/rings";
import { connect } from "../helpers/fixtures";

/**
 * GATE: matching.ring_expansion
 *
 * §12.3's Phase 3 fan-out. The spec is blunt about the risk — "exactly the
 * kind of feature that behaves fine at 10 users in a demo and falls over at
 * 500 in production" — but the failures below are not about volume. They are
 * about who gets a message they should never have received, and every one of
 * them looks like success from the manager's side: the burst went out, someone
 * replied, the shift got filled.
 *
 * The two that matter most:
 *
 *   - A locum who set `max_travel_km = 15` must never hear about a 40 km
 *     shift. The ring is the pharmacy searching outward; the limit is the
 *     locum's, and it wins. Get this backwards and the system is most annoying
 *     to the people who were most explicit.
 *
 *   - Someone already confirmed on an overlapping shift must never be offered
 *     this one. Not politeness: they would have to cancel one, and §9 charges
 *     for a late cancellation. The platform would be manufacturing the no-show
 *     it then penalises.
 */

const { db, client } = connect();

const JHB = { lng: 28.0473, lat: -26.2041 } as const;

/**
 * The fixtures live in the Northern Cape, not Johannesburg, and that is not
 * arbitrary.
 *
 * The §14 seed puts thousands of verified, opted-in locums on real Gauteng
 * density. With a per-ring cap of 25, a fixture placed in Johannesburg is
 * simply outranked and never appears — the first version of this file failed
 * four tests that way, and the failure looked like a filtering bug rather than
 * a crowded ring.
 *
 * Empty country gives each test a population it fully controls. The one test
 * that genuinely needs the crowd builds its own shift in Johannesburg.
 */
const EMPTY_KAROO = { lng: 21.0, lat: -29.0 } as const;

/** 1 degree of longitude ≈ 97 km at this latitude; near enough for bands. */
function kmEast(km: number) {
  return { lng: EMPTY_KAROO.lng + km / 97, lat: EMPTY_KAROO.lat };
}

const tag = `ring-${Date.now()}`;
let managerId = "";
let pharmacyId = "";
let shiftId = "";
const createdUserIds: string[] = [];

interface LocumOptions {
  readonly km: number;
  readonly maxTravelKm?: number;
  readonly favourite?: boolean;
  readonly verified?: boolean;
  readonly optedOut?: boolean;
  readonly noShows?: number;
  readonly completedShifts?: number;
  readonly optInAt?: Date | null;
}

async function makeLocum(name: string, options: LocumOptions): Promise<string> {
  const [user] = await db
    .insert(s.users)
    .values({
      role: "locum",
      email: `${tag}-${name}@test.invalid`,
      fullName: `Ring ${name}`,
      phone: `+2782${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      whatsappOptInAt: options.optInAt === undefined ? new Date() : options.optInAt,
      ...(options.optedOut ? { whatsappOptOutAt: new Date() } : {}),
    })
    .returning({ id: s.users.id });

  createdUserIds.push(user!.id);

  await db.insert(s.locumProfiles).values({
    userId: user!.id,
    verification: options.verified === false ? "in_review" : "verified",
    baseLocation: kmEast(options.km),
    maxTravelKm: options.maxTravelKm ?? 100,
    noShows: options.noShows ?? 0,
    completedShifts: options.completedShifts ?? 0,
  });

  if (options.favourite) {
    await db
      .insert(s.favouriteLocums)
      .values({ pharmacyId, locumId: user!.id });
  }

  return user!.id;
}

beforeAll(async () => {
  const [manager] = await db
    .insert(s.users)
    .values({ role: "manager", email: `${tag}-mgr@test.invalid`, fullName: "Ring Manager" })
    .returning({ id: s.users.id });
  managerId = manager!.id;
  createdUserIds.push(managerId);

  const [pharmacy] = await db
    .insert(s.pharmacies)
    .values({
      name: `Ring Pharmacy ${tag}`,
      addressLine: "1 Ring Road",
      city: "Carnarvon",
      location: EMPTY_KAROO,
    })
    .returning({ id: s.pharmacies.id });
  pharmacyId = pharmacy!.id;

  await db
    .insert(s.pharmacyMembers)
    .values({ pharmacyId, userId: managerId, isPrimary: true });

  const [shift] = await db
    .insert(s.shifts)
    .values({
      pharmacyId,
      createdBy: managerId,
      startsAt: new Date(Date.now() + 48 * 3_600_000),
      endsAt: new Date(Date.now() + 56 * 3_600_000),
      hourlyRateCents: 45_000,
      status: "open",
      location: EMPTY_KAROO,
    })
    .returning({ id: s.shifts.id });
  shiftId = shift!.id;
});

afterAll(async () => {
  await db.delete(s.bookings).where(eq(s.bookings.shiftId, shiftId));
  if (createdUserIds.length > 0) {
    await db
      .delete(s.bookings)
      .where(inArray(s.bookings.locumId, createdUserIds));
  }
  await db.delete(s.shifts).where(eq(s.shifts.pharmacyId, pharmacyId));
  await db.delete(s.favouriteLocums).where(eq(s.favouriteLocums.pharmacyId, pharmacyId));
  await db.delete(s.pharmacyMembers).where(eq(s.pharmacyMembers.pharmacyId, pharmacyId));
  await db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, createdUserIds));
  await db.delete(s.pharmacies).where(eq(s.pharmacies.id, pharmacyId));
  await db.delete(s.users).where(inArray(s.users.id, createdUserIds));
  await client.end();
});

describe("GATE matching.ring_expansion — the constraints that protect a person", () => {
  it("never offers a shift beyond the locum's own max travel distance", async () => {
    /*
     * THE test in this file. `homebody` is 30 km away and told us 15 km. Ring 2
     * reaches 25 km and ring 3 reaches 50 — so a pharmacy-only view of distance
     * would message them on ring 3.
     *
     * The failure is invisible from the manager's side and corrosive from the
     * locum's: the system works best for people who never stated a limit.
     */
    const homebody = await makeLocum("homebody", { km: 30, maxTravelKm: 15 });
    const willing = await makeLocum("willing", { km: 30, maxTravelKm: 100 });

    const allRings: string[] = [];
    for (let ring = 0; ring <= LAST_RING; ring += 1) {
      const found = await selectRing(db, { shiftId, ring });
      allRings.push(...found.map((c) => c.locumId));
    }

    expect(allRings).not.toContain(homebody);
    expect(allRings).toContain(willing);
  });

  it("never offers a shift to someone already confirmed elsewhere at that time", async () => {
    /*
     * They would have to cancel one, and §9 charges for a late cancellation.
     * Offering it manufactures the no-show the platform then penalises.
     */
    const busy = await makeLocum("busy", { km: 2 });

    const [otherShift] = await db
      .insert(s.shifts)
      .values({
        pharmacyId,
        createdBy: managerId,
        // Overlaps the target shift by an hour.
        startsAt: new Date(Date.now() + 55 * 3_600_000),
        endsAt: new Date(Date.now() + 60 * 3_600_000),
        hourlyRateCents: 45_000,
        status: "filled",
        location: EMPTY_KAROO,
      })
      .returning({ id: s.shifts.id });

    await db
      .insert(s.bookings)
      .values({ shiftId: otherShift!.id, locumId: busy, status: "confirmed" });

    const ring1 = await selectRing(db, { shiftId, ring: 1 });
    expect(ring1.map((c) => c.locumId)).not.toContain(busy);
  });

  it("offers to someone whose other booking does NOT overlap", async () => {
    // The control. Without it, the exclusion above passes on a query that
    // excludes anyone with any booking at all.
    const free = await makeLocum("free", { km: 3 });

    const [laterShift] = await db
      .insert(s.shifts)
      .values({
        pharmacyId,
        createdBy: managerId,
        startsAt: new Date(Date.now() + 200 * 3_600_000),
        endsAt: new Date(Date.now() + 208 * 3_600_000),
        hourlyRateCents: 45_000,
        status: "filled",
        location: EMPTY_KAROO,
      })
      .returning({ id: s.shifts.id });

    await db
      .insert(s.bookings)
      .values({ shiftId: laterShift!.id, locumId: free, status: "confirmed" });

    const ring1 = await selectRing(db, { shiftId, ring: 1 });
    expect(ring1.map((c) => c.locumId)).toContain(free);
  });

  it("excludes unverified locums", async () => {
    // §5 — the manager is buying trust in a checked SAPC number. Offering work
    // to someone nobody has verified is the product failing at its only job.
    const unverified = await makeLocum("unverified", { km: 4, verified: false });
    const ring1 = await selectRing(db, { shiftId, ring: 1 });
    expect(ring1.map((c) => c.locumId)).not.toContain(unverified);
  });

  it("excludes locums who opted out of WhatsApp, at selection not at send", async () => {
    /*
     * §11.4. `sendWhatsAppMessage` would suppress these anyway and be right to
     * — but a ring of 25 that silently suppresses 20 has become a ring of
     * five, and nobody is told. Filtering here means the ring is 25 people who
     * can actually be reached.
     */
    const optedOut = await makeLocum("optedout", { km: 5, optedOut: true });
    const neverOptedIn = await makeLocum("neveroptedin", { km: 5, optInAt: null });

    const ring1 = await selectRing(db, { shiftId, ring: 1 });
    const ids = ring1.map((c) => c.locumId);
    expect(ids).not.toContain(optedOut);
    expect(ids).not.toContain(neverOptedIn);
  });

  it("does not re-offer to someone who already applied", async () => {
    const applicant = await makeLocum("applicant", { km: 6 });
    await db
      .insert(s.bookings)
      .values({ shiftId, locumId: applicant, status: "requested" });

    const ring1 = await selectRing(db, { shiftId, ring: 1 });
    expect(ring1.map((c) => c.locumId)).not.toContain(applicant);
  });
});

describe("GATE matching.ring_expansion — rings are an escalation", () => {
  it("puts favourites in ring 0 regardless of distance", async () => {
    /*
     * §10.1 makes favourites the default audience. A regular who has moved
     * across town is still the person the manager actually relies on — so
     * ring 0 ignores the band, though never the locum's own limit.
     */
    const farRegular = await makeLocum("farregular", { km: 40, favourite: true });
    const ring0 = await selectRing(db, { shiftId, ring: 0 });
    expect(ring0.map((c) => c.locumId)).toContain(farRegular);
  });

  it("does not repeat favourites in later rings", async () => {
    /*
     * They were told first, on purpose. Including them again sends a second
     * message about the same shift to the person most likely to be deciding
     * right now — and each message costs money that §11.6 caps.
     */
    const regular = await makeLocum("regular", { km: 5, favourite: true });

    const ring0 = (await selectRing(db, { shiftId, ring: 0 })).map((c) => c.locumId);
    expect(ring0).toContain(regular);

    for (let ring = 1; ring <= LAST_RING; ring += 1) {
      const later = await selectRing(db, { shiftId, ring });
      expect(later.map((c) => c.locumId)).not.toContain(regular);
    }
  });

  it("keeps each ring inside its own distance band", async () => {
    // Bands do not overlap, so escalation reaches new people rather than
    // re-reaching the same ones further down a list.
    const near = await makeLocum("near", { km: 5 });
    const mid = await makeLocum("mid", { km: 18 });
    const far = await makeLocum("far", { km: 40 });

    const ring1 = (await selectRing(db, { shiftId, ring: 1 })).map((c) => c.locumId);
    const ring2 = (await selectRing(db, { shiftId, ring: 2 })).map((c) => c.locumId);
    const ring3 = (await selectRing(db, { shiftId, ring: 3 })).map((c) => c.locumId);

    expect(ring1).toContain(near);
    expect(ring1).not.toContain(mid);
    expect(ring2).toContain(mid);
    expect(ring2).not.toContain(far);
    expect(ring3).toContain(far);
  });

  it("orders by reliability before distance", async () => {
    /*
     * Deliberately not nearest-first. The manager's problem is "who will turn
     * up", not "who is closest" — a no-show means a pharmacy that legally
     * cannot trade. §12.3 names distance AND reliability together.
     */
    const flaky = await makeLocum("flaky", { km: 1, noShows: 3, completedShifts: 20 });
    const solid = await makeLocum("solid", { km: 9, noShows: 0, completedShifts: 20 });

    const ring1 = (await selectRing(db, { shiftId, ring: 1 })).map((c) => c.locumId);
    expect(ring1.indexOf(solid)).toBeLessThan(ring1.indexOf(flaky));
  });

  it("selects nobody for a ring past the last band", async () => {
    // An escalation loop that runs one step too far must stop, not widen
    // silently to "everyone".
    expect(await selectRing(db, { shiftId, ring: LAST_RING + 1 })).toHaveLength(0);
  });

  it("stops escalating after the last ring", () => {
    const from = new Date("2026-08-02T09:00:00Z");
    expect(nextRingDueAt(0, from)).toEqual(new Date("2026-08-02T09:12:00Z"));
    expect(nextRingDueAt(LAST_RING, from)).toBeUndefined();
  });

  it("notifies nobody about a shift that is no longer open", async () => {
    /*
     * The escalation timer fires after a delay, and by then the shift is
     * usually filled — that is the normal case, not an edge case. Checked
     * inside selectRing rather than only at the caller, because a caller that
     * forgets sends messages about a shift someone else already took.
     */
    await db.update(s.shifts).set({ status: "filled" }).where(eq(s.shifts.id, shiftId));
    expect(await selectRing(db, { shiftId, ring: 0 })).toHaveLength(0);
    expect(await selectRing(db, { shiftId, ring: 1 })).toHaveLength(0);
    await db.update(s.shifts).set({ status: "open" }).where(eq(s.shifts.id, shiftId));
  });

  it("never returns more than the per-ring cap", async () => {
    /*
     * The bound that stops one dense metro shift from becoming a four-figure
     * WhatsApp bill.
     *
     * Deliberately built in JOHANNESBURG rather than out in the Karoo with the
     * rest of this file: the §14 seed puts thousands of verified locums on real
     * Gauteng density, and a cap can only be shown to bind where there are
     * more eligible people than the cap allows. Asserted, not assumed — if the
     * seed were absent this test would fail rather than pass vacuously.
     */
    const [densePharmacy] = await db
      .insert(s.pharmacies)
      .values({
        name: `Ring Dense ${tag}`,
        addressLine: "1 Dense Road",
        city: "Johannesburg",
        location: JHB,
      })
      .returning({ id: s.pharmacies.id });

    await db
      .insert(s.pharmacyMembers)
      .values({ pharmacyId: densePharmacy!.id, userId: managerId, isPrimary: false });

    const [denseShift] = await db
      .insert(s.shifts)
      .values({
        pharmacyId: densePharmacy!.id,
        createdBy: managerId,
        startsAt: new Date(Date.now() + 48 * 3_600_000),
        endsAt: new Date(Date.now() + 56 * 3_600_000),
        hourlyRateCents: 45_000,
        status: "open",
        location: JHB,
      })
      .returning({ id: s.shifts.id });

    /*
     * How many people WOULD be eligible without the cap. If the seed is
     * missing this is small, the expectation below fails, and the cap test
     * fails loudly instead of passing against an empty ring.
     */
    const [eligible] = await db
      .select({ n: sql<number>`count(*)` })
      .from(s.locumProfiles)
      .innerJoin(s.users, eq(s.users.id, s.locumProfiles.userId))
      .where(
        sql`${s.locumProfiles.verification} = 'verified'
            and ${s.users.whatsappOptInAt} is not null
            and ${s.users.whatsappOptOutAt} is null
            and ${s.locumProfiles.baseLocation} is not null
            and ST_DWithin(
                  ${s.locumProfiles.baseLocation},
                  ST_SetSRID(ST_MakePoint(${JHB.lng}, ${JHB.lat}), 4326)::geography,
                  10000
                )`,
      );

    expect(Number(eligible!.n)).toBeGreaterThan(MAX_PER_RING);

    const ring1 = await selectRing(db, { shiftId: denseShift!.id, ring: 1 });
    expect(ring1.length).toBe(MAX_PER_RING);

    await db.delete(s.shifts).where(eq(s.shifts.id, denseShift!.id));
    await db
      .delete(s.pharmacyMembers)
      .where(eq(s.pharmacyMembers.pharmacyId, densePharmacy!.id));
    await db.delete(s.pharmacies).where(eq(s.pharmacies.id, densePharmacy!.id));
  });

  it("honours an explicit exclusion list", async () => {
    const first = await selectRing(db, { shiftId, ring: 1, limit: 3 });
    expect(first.length).toBeGreaterThan(0);

    const second = await selectRing(db, {
      shiftId,
      ring: 1,
      excludeLocumIds: first.map((c) => c.locumId),
      limit: 3,
    });
    for (const candidate of second) {
      expect(first.map((c) => c.locumId)).not.toContain(candidate.locumId);
    }
  });

  it("reports the distance it matched on", async () => {
    // Carried out so a manager can be told why someone was suggested, and so a
    // wrong band is visible in a log rather than inferred from who complained.
    const ring1 = await selectRing(db, { shiftId, ring: 1 });
    for (const candidate of ring1) {
      expect(candidate.distanceKm).toBeGreaterThanOrEqual(0);
      expect(candidate.distanceKm).toBeLessThanOrEqual(RING_BANDS_KM[0]! + 0.5);
    }
  });
});

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  DISCLOSURE_BATCH,
  MIN_DISTINCT_RATERS,
  MIN_PLAUSIBLE_RATER_POOL,
  computeReputation,
  getReputation,
  isDomainError,
  rateBooking,
  ratingsForDisclosure,
  unratedBookingsFor,
  type ReputationInput,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: product.reputation
 *
 * §7 in one line: "unified reputation tiers with density-aware anonymization".
 *
 * The tier bands are a product opinion and could reasonably be argued with.
 * The anonymisation is not — it is the difference between a rating system that
 * collects honest opinions and one that collects safe ones. Every test below
 * about withholding is protecting a specific, nameable person: the relief
 * pharmacist who rated a pharmacy three stars and needs a shift from them
 * again in March.
 *
 * These rules are also the ones most likely to be quietly relaxed later by
 * someone who finds too many tiers withheld. That is why the thresholds are
 * asserted by behaviour rather than by reading the constants back.
 */

const { db, client } = connect();
const JHB = { lng: 28.0473, lat: -26.2041 };

const createdUserIds: string[] = [];
const createdPharmacyIds: string[] = [];

function ratingsFrom(...pairs: Array<[rater: string, score: number]>) {
  return pairs.map(([raterId, score], i) => ({
    raterId,
    score,
    createdAt: new Date(2026, 0, i + 1),
  }));
}

function input(overrides: Partial<ReputationInput> = {}): ReputationInput {
  return {
    ratings: ratingsFrom(["a", 5], ["b", 5], ["c", 4]),
    completedShifts: 20,
    noShows: 0,
    plausibleRaterPool: 40,
    ...overrides,
  };
}

afterEach(async () => {
  const users = createdUserIds.splice(0);
  const pharmacies = createdPharmacyIds.splice(0);
  if (users.length > 0) {
    await db.delete(s.ratings).where(inArray(s.ratings.raterId, users));
    await db.delete(s.ratings).where(inArray(s.ratings.rateeId, users));
  }
  if (pharmacies.length > 0) {
    await db.delete(s.pharmacies).where(inArray(s.pharmacies.id, pharmacies));
  }
  if (users.length > 0) {
    await db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, users));
    await db.delete(s.users).where(inArray(s.users.id, users));
  }
});

afterAll(async () => {
  await client.end();
});

describe("GATE product.reputation — §7 anonymisation", () => {
  it("withholds a tier below the distinct-rater floor", () => {
    /*
     * Two raters is the case that matters most, and it is not solved by
     * averaging: a subject who knows one rater's opinion — and in this market
     * they usually do, because they spoke to them — recovers the other's by
     * subtraction.
     */
    const result = computeReputation(
      input({ ratings: ratingsFrom(["a", 5], ["b", 2]) }),
    );
    expect(result.display).toEqual({ kind: "withheld", reason: "too_few_raters" });
  });

  it("shows a tier once the floor is met", () => {
    const result = computeReputation(input());
    expect(result.display.kind).toBe("tier");
    expect(MIN_DISTINCT_RATERS).toBe(3);
  });

  it("does not count one pharmacy's repeat bookings as independent opinions", () => {
    /*
     * A locum working every Saturday for the same pharmacy accumulates a dozen
     * ratings that are one relationship. Without this, that pharmacy alone
     * decides the locum's public tier — which is leverage, not reputation.
     */
    const result = computeReputation(
      input({
        ratings: ratingsFrom(
          ["regular", 5], ["regular", 5], ["regular", 5],
          ["regular", 5], ["regular", 5], ["regular", 5],
          ["b", 4], ["c", 4],
        ),
      }),
    );
    expect(result.display).toEqual({
      kind: "withheld",
      reason: "dominated_by_one_rater",
    });
    // The counts are still safe to show — a total identifies nobody.
    expect(result.ratingCount).toBe(8);
    expect(result.distinctRaters).toBe(3);
  });

  it("withholds everything in a market too thin for anonymity to exist", () => {
    /*
     * The honest limitation, asserted rather than engineered around. With four
     * pharmacies in range there is no floor that hides a rater, so nothing is
     * shown — even though there is plenty of data. A tier here would be a trap
     * for whoever left the rating.
     */
    const result = computeReputation(
      input({
        plausibleRaterPool: 4,
        ratings: ratingsFrom(["a", 5], ["b", 4], ["c", 5], ["d", 4], ["e", 5]),
      }),
    );
    expect(result.display).toEqual({ kind: "withheld", reason: "market_too_thin" });
    expect(MIN_PLAUSIBLE_RATER_POOL).toBe(10);
  });

  it("asks for more raters where more raters are obtainable", () => {
    /*
     * Density-aware means the floor MOVES with the market — same three
     * ratings, different verdicts.
     *
     * The direction took a correction. The intuitive rule is "a sparse market
     * is riskier, so demand more raters there", which is half right and wholly
     * unworkable: a sparse market cannot supply them, so that rule withholds
     * forever. Sparse markets are refused outright instead
     * (`market_too_thin`). Above that line a larger k is simply better
     * protection, and a larger pool is where a larger k can actually be had.
     */
    const three = ratingsFrom(["a", 5], ["b", 5], ["c", 5]);

    // Sparse but viable: the absolute floor governs.
    expect(
      computeReputation(input({ ratings: three, plausibleRaterPool: 12 })).display.kind,
    ).toBe("tier");

    // Dense: three voices out of a hundred is not yet enough to publish.
    expect(
      computeReputation(input({ ratings: three, plausibleRaterPool: 100 })).display,
    ).toEqual({ kind: "withheld", reason: "too_few_raters" });

    // ...but the demand is capped, so a busy metro still publishes.
    const five = ratingsFrom(["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 4]);
    expect(
      computeReputation(input({ ratings: five, plausibleRaterPool: 500 })).display.kind,
    ).toBe("tier");
  });

  it("will not refresh a tier on a single new rating", () => {
    /*
     * Delta protection, and the control most systems miss. With a hundred
     * ratings the k-anonymity floor is long satisfied — and if the tier
     * recomputes the moment rating 101 lands, the subject solves for rating
     * 101 exactly. Anonymity in aggregate is not anonymity over time.
     */
    const hundred = Array.from({ length: 100 }, (_, i) => `r${i}`);

    expect(ratingsForDisclosure(hundred, 100)).toBeUndefined();
    expect(ratingsForDisclosure([...hundred, "r100"], 100)).toBeUndefined();
    expect(ratingsForDisclosure([...hundred, "r100", "r101"], 100)).toHaveLength(102);
    expect(DISCLOSURE_BATCH).toBe(2);
  });

  it("says nothing at all before the first rating", () => {
    const result = computeReputation(input({ ratings: [] }));
    expect(result.display).toEqual({ kind: "withheld", reason: "no_ratings" });
  });
});

describe("GATE product.reputation — §7 tiers", () => {
  it("weighs a no-show far above a poor review", () => {
    /*
     * A three-star rating means a shift was disappointing. A no-show means a
     * pharmacy could not legally dispense that day. Averaging them would let
     * a run of pleasant reviews bury the single failure this product exists to
     * prevent.
     */
    const glowing = computeReputation(
      input({
        ratings: ratingsFrom(["a", 5], ["b", 5], ["c", 5], ["d", 5]),
        completedShifts: 8,
        noShows: 1,
      }),
    );
    expect(glowing.display).toEqual({ kind: "tier", tier: "concerning" });
  });

  it("does not let one old no-show condemn a long record", () => {
    const seasoned = computeReputation(
      input({
        ratings: ratingsFrom(["a", 5], ["b", 5], ["c", 5], ["d", 4]),
        completedShifts: 200,
        noShows: 1,
      }),
    );
    expect(seasoned.display.kind).toBe("tier");
    expect(seasoned.display).not.toEqual({ kind: "tier", tier: "concerning" });
  });

  it("holds back the top tier until there is a real track record", () => {
    // Three five-star ratings from three shifts is not evidence of excellence,
    // it is evidence of three good days.
    const fresh = computeReputation(
      input({ ratings: ratingsFrom(["a", 5], ["b", 5], ["c", 5]), completedShifts: 3 }),
    );
    expect(fresh.display).toEqual({ kind: "tier", tier: "reliable" });

    const proven = computeReputation(
      input({
        ratings: ratingsFrom(["a", 5], ["b", 5], ["c", 5], ["d", 5]),
        completedShifts: 60,
      }),
    );
    expect(proven.display).toEqual({ kind: "tier", tier: "excellent" });
  });
});

describe("GATE product.reputation — §7 rating a booking", () => {
  interface Scene {
    managerId: string;
    locumId: string;
    outsiderId: string;
    bookingId: string;
  }

  async function makeScene(endsAt: Date, status: "completed" | "cancelled_by_locum" = "completed"): Promise<Scene> {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [manager, locum, outsider] = await db
      .insert(s.users)
      .values([
        { role: "manager", email: `rep-m-${tag}@test.invalid`, fullName: "Manager" },
        { role: "locum", email: `rep-l-${tag}@test.invalid`, fullName: "Locum" },
        { role: "locum", email: `rep-o-${tag}@test.invalid`, fullName: "Outsider" },
      ])
      .returning({ id: s.users.id });
    createdUserIds.push(manager!.id, locum!.id, outsider!.id);

    const [pharmacy] = await db
      .insert(s.pharmacies)
      .values({ name: `Rep ${tag}`, addressLine: "1 Rd", city: "Johannesburg", location: JHB })
      .returning({ id: s.pharmacies.id });
    createdPharmacyIds.push(pharmacy!.id);

    await db
      .insert(s.pharmacyMembers)
      .values({ pharmacyId: pharmacy!.id, userId: manager!.id, isPrimary: true });
    await db
      .insert(s.locumProfiles)
      .values({ userId: locum!.id, verification: "verified", baseLocation: JHB });

    const [shift] = await db
      .insert(s.shifts)
      .values({
        pharmacyId: pharmacy!.id,
        createdBy: manager!.id,
        startsAt: new Date(endsAt.getTime() - 8 * 3_600_000),
        endsAt,
        status: "completed",
        hourlyRateCents: 45_000,
        location: JHB,
      })
      .returning({ id: s.shifts.id });

    const [booking] = await db
      .insert(s.bookings)
      .values({ shiftId: shift!.id, locumId: locum!.id, status })
      .returning({ id: s.bookings.id });

    return {
      managerId: manager!.id,
      locumId: locum!.id,
      outsiderId: outsider!.id,
      bookingId: booking!.id,
    };
  }

  const yesterday = () => new Date(Date.now() - 24 * 3_600_000);

  it("lets each side rate the other once the shift has ended", async () => {
    const scene = await makeScene(yesterday());

    const byManager = await rateBooking(db, {
      bookingId: scene.bookingId,
      raterId: scene.managerId,
      score: 5,
    });
    expect(byManager.ratingId).toBeTruthy();

    // §7 "unified" — the locum rates the pharmacy on the same scale. A
    // marketplace that rates only its scarce side teaches that side the
    // platform is something done to them.
    const byLocum = await rateBooking(db, {
      bookingId: scene.bookingId,
      raterId: scene.locumId,
      score: 4,
    });
    expect(byLocum.ratingId).toBeTruthy();

    const [subject] = await db
      .select({ score: s.ratings.score })
      .from(s.ratings)
      .where(eq(s.ratings.rateeId, scene.locumId));
    expect(subject!.score).toBe(5);
  });

  it("refuses to rate a shift that has not finished", async () => {
    // A manager who can rate before the shift holds a lever over someone who
    // has not worked yet.
    const scene = await makeScene(new Date(Date.now() + 24 * 3_600_000));
    const error = await rateBooking(db, {
      bookingId: scene.bookingId,
      raterId: scene.managerId,
      score: 1,
    }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe("SHIFT_NOT_FINISHED");
  });

  it("refuses a second rating rather than overwriting the first", async () => {
    // A rating revisable after seeing its effect is a negotiating position.
    const scene = await makeScene(yesterday());
    await rateBooking(db, { bookingId: scene.bookingId, raterId: scene.managerId, score: 5 });

    const error = await rateBooking(db, {
      bookingId: scene.bookingId,
      raterId: scene.managerId,
      score: 1,
    }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe("ALREADY_RATED");
  });

  it("refuses a rater who was not part of the booking", async () => {
    const scene = await makeScene(yesterday());
    const error = await rateBooking(db, {
      bookingId: scene.bookingId,
      raterId: scene.outsiderId,
      score: 1,
    }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe("NOT_BOOKING_PARTICIPANT");
  });

  it("refuses to rate a cancelled shift", async () => {
    /*
     * Nobody worked, so there is nothing to rate — and §9 already charges the
     * pharmacy R10 for a late cancellation. Letting it become a one-star
     * rating too would punish one event twice, on a signal other pharmacies
     * read as work quality.
     */
    const scene = await makeScene(yesterday(), "cancelled_by_locum");
    const error = await rateBooking(db, {
      bookingId: scene.bookingId,
      raterId: scene.managerId,
      score: 1,
    }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe("BOOKING_NOT_RATEABLE");
  });

  it("rejects a score outside 1–5", async () => {
    const scene = await makeScene(yesterday());
    for (const score of [0, 6, 3.5]) {
      const error = await rateBooking(db, {
        bookingId: scene.bookingId,
        raterId: scene.managerId,
        score,
      }).catch((e: unknown) => e);
      expect(isDomainError(error) && error.code, `score ${score}`).toBe("INVALID_RATING");
    }
  });

  it("prompts BOTH sides to rate, not just the locum", async () => {
    /*
     * §7's first word is "unified". The first version of unratedBookingsFor
     * keyed on bookings.locum_id alone, so the manager was never asked —
     * producing a system that collects ratings in one direction and calls it
     * two-sided. That is the exact drift the word exists to prevent.
     */
    const scene = await makeScene(yesterday());

    const forLocum = await unratedBookingsFor(db, scene.locumId);
    const forManager = await unratedBookingsFor(db, scene.managerId);

    expect(forLocum.map((r) => r.bookingId)).toContain(scene.bookingId);
    expect(
      forManager.map((r) => r.bookingId),
      "the pharmacy side must be prompted too",
    ).toContain(scene.bookingId);

    // Once someone has rated, they stop being asked.
    await rateBooking(db, { bookingId: scene.bookingId, raterId: scene.managerId, score: 5 });
    expect(
      (await unratedBookingsFor(db, scene.managerId)).map((r) => r.bookingId),
    ).not.toContain(scene.bookingId);
    // ...and the other side is still asked.
    expect(
      (await unratedBookingsFor(db, scene.locumId)).map((r) => r.bookingId),
    ).toContain(scene.bookingId);

    // An outsider is never asked.
    expect(
      (await unratedBookingsFor(db, scene.outsiderId)).map((r) => r.bookingId),
    ).not.toContain(scene.bookingId);
  });

  it("withholds a tier for a locum with no base location", async () => {
    /*
     * Fail closed. Without a location there is no way to size the local
     * market, and an unknown density must not be read as a dense one — that
     * would expose raters exactly where we know least.
     */
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [locum] = await db
      .insert(s.users)
      .values({ role: "locum", email: `rep-nb-${tag}@test.invalid`, fullName: "Nowhere" })
      .returning({ id: s.users.id });
    createdUserIds.push(locum!.id);
    await db.insert(s.locumProfiles).values({ userId: locum!.id, verification: "verified" });

    const reputation = await getReputation(db, locum!.id);
    expect(reputation.display.kind).toBe("withheld");
  });
});

describe("GATE product.reputation — §7 delta protection wiring (getReputation)", () => {
  /**
   * `ratingsForDisclosure` above is proven as a pure function; these tests
   * prove `getReputation` actually CALLS it. It did not until this gate: the
   * function recomputed a fresh tier from every rating on every read, so the
   * delta-protection control described at the top of tiers.ts was dead code
   * in production — reputation_snapshots is the checkpoint that closes that
   * gap.
   */
  async function makeRatingScene(locumId: string, endsAt: Date) {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [manager] = await db
      .insert(s.users)
      .values({ role: "manager", email: `rep-delta-m-${tag}@test.invalid`, fullName: "Manager" })
      .returning({ id: s.users.id });
    createdUserIds.push(manager!.id);

    const [pharmacy] = await db
      .insert(s.pharmacies)
      .values({ name: `Delta ${tag}`, addressLine: "1 Rd", city: "Johannesburg", location: JHB })
      .returning({ id: s.pharmacies.id });
    createdPharmacyIds.push(pharmacy!.id);

    await db
      .insert(s.pharmacyMembers)
      .values({ pharmacyId: pharmacy!.id, userId: manager!.id, isPrimary: true });

    const [shift] = await db
      .insert(s.shifts)
      .values({
        pharmacyId: pharmacy!.id,
        createdBy: manager!.id,
        startsAt: new Date(endsAt.getTime() - 8 * 3_600_000),
        endsAt,
        status: "completed",
        hourlyRateCents: 45_000,
        location: JHB,
      })
      .returning({ id: s.shifts.id });

    const [booking] = await db
      .insert(s.bookings)
      .values({ shiftId: shift!.id, locumId, status: "completed" })
      .returning({ id: s.bookings.id });

    return { managerId: manager!.id, bookingId: booking!.id };
  }

  const yesterday = () => new Date(Date.now() - 24 * 3_600_000);

  it("does not move the published tier until DISCLOSURE_BATCH new ratings arrive", async () => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [locum] = await db
      .insert(s.users)
      .values({ role: "locum", email: `rep-delta-l-${tag}@test.invalid`, fullName: "Delta Locum" })
      .returning({ id: s.users.id });
    createdUserIds.push(locum!.id);
    await db
      .insert(s.locumProfiles)
      .values({ userId: locum!.id, verification: "verified", baseLocation: JHB, completedShifts: 20 });

    // MAX_REQUIRED_RATERS caps the distinct-rater floor at 5 regardless of how
    // dense the seeded market is, so five raters always clears it.
    for (let i = 0; i < 5; i += 1) {
      const scene = await makeRatingScene(locum!.id, yesterday());
      await rateBooking(db, { bookingId: scene.bookingId, raterId: scene.managerId, score: 5 });
    }

    const published = await getReputation(db, locum!.id);
    expect(published.display).toEqual({ kind: "tier", tier: "excellent" });
    expect(published.ratingCount).toBe(5);

    // One new, very different rating (6th total) arrives. Recomputing on it
    // alone would let the subject solve for exactly what it was — so the
    // published tier must not move yet, even though the ALWAYS-SAFE counts do.
    const sixth = await makeRatingScene(locum!.id, yesterday());
    await rateBooking(db, { bookingId: sixth.bookingId, raterId: sixth.managerId, score: 1 });

    const stillCached = await getReputation(db, locum!.id);
    expect(stillCached.display).toEqual(published.display);
    expect(stillCached.ratingCount).toBe(6);

    // A second new rating (7th total) crosses DISCLOSURE_BATCH since the last
    // publish (5 -> 7 is +2). The tier is now allowed to recompute, and with
    // two one-star ratings pulling the mean down it actually changes.
    const seventh = await makeRatingScene(locum!.id, yesterday());
    await rateBooking(db, { bookingId: seventh.bookingId, raterId: seventh.managerId, score: 1 });

    const recomputed = await getReputation(db, locum!.id);
    expect(recomputed.display).not.toEqual(published.display);
    expect(recomputed.ratingCount).toBe(7);
  });

  it("publishes immediately for a subject's very first rating", async () => {
    // No prior snapshot means no earlier state to diff against, so there is
    // nothing a first publish could leak — it must not wait for a second
    // rating to arrive before showing anything.
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [locum] = await db
      .insert(s.users)
      .values({ role: "locum", email: `rep-delta-first-${tag}@test.invalid`, fullName: "First Timer" })
      .returning({ id: s.users.id });
    createdUserIds.push(locum!.id);
    await db
      .insert(s.locumProfiles)
      .values({ userId: locum!.id, verification: "verified", baseLocation: JHB, completedShifts: 20 });

    for (let i = 0; i < 5; i += 1) {
      const scene = await makeRatingScene(locum!.id, yesterday());
      await rateBooking(db, { bookingId: scene.bookingId, raterId: scene.managerId, score: 5 });
    }

    const result = await getReputation(db, locum!.id);
    expect(result.display).toEqual({ kind: "tier", tier: "excellent" });

    const [snapshot] = await db
      .select()
      .from(s.reputationSnapshots)
      .where(eq(s.reputationSnapshots.subjectId, locum!.id));
    expect(snapshot?.publishedRatingCount).toBe(5);
  });
});

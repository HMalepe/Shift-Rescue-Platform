import { and, eq, isNull, sql } from "drizzle-orm";
import {
  bookings,
  favouriteLocums,
  locumProfiles,
  shifts,
  users,
  type Database,
} from "@locum/db";

/**
 * §12.3 Phase 3 — proactive matching: who gets told about a shift, and when.
 *
 * The spec describes the feature as firing "a notification burst the instant a
 * manager toggles 'Looking for a Locum' — pushing to favorited locums, then
 * expanding by distance/reliability", and immediately calls it "exactly the
 * kind of feature that behaves fine at 10 users in a demo and falls over at
 * 500 in production".
 *
 * ## Rings are an escalation, not a broadcast
 *
 * The obvious reading of "burst" is: message everyone eligible, at once. This
 * does not do that, for three reasons that all point the same way.
 *
 *   1. Every message costs money and cannot be recalled. §11.6 caps daily
 *      spend, and a cap that is hit at 08:00 by one over-eager fan-out has
 *      silenced every booking confirmation for the rest of the day.
 *   2. A shift needs ONE pharmacist. Messaging two hundred people to fill one
 *      slot means at least a hundred and ninety-nine people were interrupted
 *      for nothing, and the ones who respond and lose learn that responding is
 *      not worth it.
 *   3. Favourites are the product's promise to the manager (§10.1: shifts
 *      default to favourites-only). If ring 2 goes out simultaneously, being
 *      someone's regular is worth nothing.
 *
 * So: ring 0 is favourites, immediately. Later rings are released only if the
 * shift is still unfilled after a delay. `selectRing` returns one ring; the
 * caller decides whether to escalate, and `nextRingDueAt` says when.
 *
 * ## What is NOT negotiable per candidate
 *
 * Distance is a two-sided constraint, and only one side is obvious. The
 * pharmacy searches outward in rings; the locum has set `maxTravelKm`, and a
 * locum who said 15 km must never be messaged about a 40 km shift no matter
 * how wide the ring has grown. Getting this backwards produces a system that
 * is most annoying to the people who were most explicit about their limits.
 */

/** Ring 0 is favourites. Later rings are distance bands, in kilometres. */
export const RING_BANDS_KM: readonly number[] = [10, 25, 50];

/**
 * How long a ring is given before the next one is released.
 *
 * Long enough that a locum who is with a patient can still be first to answer;
 * short enough that a manager filling a shift for tomorrow morning is not
 * waiting an hour to hear from anyone beyond their regulars.
 */
export const RING_ESCALATION_MINUTES = 12;

/**
 * The most people any single ring may wake.
 *
 * A bound rather than a target: most rings will return far fewer. It exists so
 * that one dense metro shift cannot turn a fan-out into a four-figure WhatsApp
 * bill, and so the §12.3 load test has a number to hold the system to.
 */
export const MAX_PER_RING = 25;

/**
 * The most people a single shift may EVER be broadcast to, across all rings.
 *
 * Separate from the per-ring cap because escalation multiplies: four rings of
 * twenty-five is a hundred messages for one vacancy, which is past the point
 * where the product is helping anyone.
 */
export const MAX_TOTAL_PER_SHIFT = 60;

export interface RingCandidate {
  readonly locumId: string;
  readonly distanceKm: number;
  readonly ring: number;
  /** §7 inputs, carried so the caller can explain an ordering it did not choose. */
  readonly completedShifts: number;
  readonly noShows: number;
}

export interface SelectRingInput {
  readonly shiftId: string;
  /** 0 = favourites; 1..RING_BANDS_KM.length = distance bands. */
  readonly ring: number;
  /** Already notified for this shift in earlier rings; never messaged twice. */
  readonly excludeLocumIds?: readonly string[];
  readonly limit?: number;
}

/**
 * Selects the locums in one ring, best first.
 *
 * One query rather than a fetch-then-filter loop. The fan-out is the §12.3
 * load-test target and runs against 5 000 locums with a GiST index on
 * `base_location`; pulling candidates into memory to filter them would turn an
 * index scan into a sequential one at exactly the moment the system is busiest.
 */
export async function selectRing(
  db: Database,
  input: SelectRingInput,
): Promise<readonly RingCandidate[]> {
  const [shift] = await db
    .select({
      id: shifts.id,
      location: shifts.location,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      status: shifts.status,
    })
    .from(shifts)
    .where(eq(shifts.id, input.shiftId))
    .limit(1);

  if (!shift) return [];

  /*
   * A filled or cancelled shift notifies nobody, checked here rather than
   * only at the caller. The escalation timer is the whole point of this
   * module, and a timer that fires after the shift was filled is the normal
   * case, not an edge case.
   */
  if (shift.status !== "open") return [];

  const limit = Math.min(input.limit ?? MAX_PER_RING, MAX_PER_RING);
  const excluded = input.excludeLocumIds ?? [];

  /*
   * The distance band for this ring. Ring 0 ignores distance entirely — a
   * manager's regular is worth telling even if they have moved across town,
   * because that relationship is the thing the manager is actually relying on.
   * Their own maxTravelKm still applies below, so "regular" does not override
   * a limit the locum set.
   */
  const bandInnerKm =
    input.ring <= 1 ? 0 : (RING_BANDS_KM[input.ring - 2] ?? 0);

  // A ring past the last band selects nobody, rather than widening silently to
  // "everyone". An escalation loop that runs one step too far must stop, not
  // become an unbounded broadcast.
  const bandOuterKm: number | null =
    input.ring === 0 ? null : (RING_BANDS_KM[input.ring - 1] ?? null);
  if (input.ring > 0 && bandOuterKm === null) return [];

  /*
   * The shift's point is built in SQL from its own row, not round-tripped
   * through JavaScript.
   *
   * Selecting `location` into JS and binding it back produced "parse error -
   * invalid geometry": the driver sends the decoded object, and PostGIS is
   * handed something that is not WKB. Keeping the geometry in the database is
   * also the faster shape — the GiST index on `base_location` is usable either
   * way, but there is no serialise/parse round trip per fan-out.
   */
  const shiftPoint = sql`(select location from ${shifts} where id = ${input.shiftId})`;
  const distanceM = sql<number>`ST_Distance(${locumProfiles.baseLocation}, ${shiftPoint})`;

  const rows = await db
    .select({
      locumId: locumProfiles.userId,
      distanceM,
      completedShifts: locumProfiles.completedShifts,
      noShows: locumProfiles.noShows,
    })
    .from(locumProfiles)
    .innerJoin(users, eq(users.id, locumProfiles.userId))
    .where(
      and(
        // §5 — an unverified locum is not offered work. The manager is buying
        // trust in the SAPC number; offering someone whose number nobody has
        // checked is the product failing at its only real job.
        eq(locumProfiles.verification, "verified"),
        isNull(users.disabledAt),
        isNull(users.erasedAt),
        /*
         * §11.4 — opt-out is honoured HERE, not only at send time.
         *
         * `sendWhatsAppMessage` would suppress these anyway, and the
         * suppression would be correct. But a fan-out that selects 25 people
         * and silently suppresses 20 of them has quietly become a fan-out of
         * five, and the manager is told nothing. Filtering at selection means
         * the ring is 25 people who can actually be reached.
         */
        isNull(users.whatsappOptOutAt),
        sql`${users.whatsappOptInAt} is not null`,
        sql`${locumProfiles.baseLocation} is not null`,
        /*
         * The band, expressed with ST_DWithin rather than ST_Distance — and
         * the difference is the whole performance story of this module.
         *
         * `ST_Distance(a, b) <= r` is a FILTER: Postgres computes the distance
         * for every candidate row and discards most of them. EXPLAIN ANALYZE
         * on the seeded 5 000-locum database showed exactly that — an index
         * scan on `verification` with the distance as a filter, and the GiST
         * index on `base_location` never touched.
         *
         * `ST_DWithin(a, b, r)` with a CONSTANT radius is index-usable, so the
         * GiST index eliminates before any distance is computed. Measured, same
         * query, same 259 matching rows:
         *
         *   ST_Distance filter   cost 28386   18.3 ms   (verification idx scan)
         *   ST_DWithin           cost    20   11.6 ms   (base_location GiST)
         *
         * The wall-clock gain at this size is unremarkable and that is the
         * point worth being honest about: what changed is the SHAPE. The first
         * plan reads every verified profile and is O(n); the second is bounded
         * by the radius. At 5 000 locums both look fine, which is precisely
         * the §12.3 trap — "behaves fine at 10 users in a demo and falls over
         * at 500 in production".
         */
        bandOuterKm === null
          ? sql`true`
          : sql`ST_DWithin(${locumProfiles.baseLocation}, ${shiftPoint}, ${bandOuterKm * 1000})`,
        bandInnerKm > 0
          ? sql`not ST_DWithin(${locumProfiles.baseLocation}, ${shiftPoint}, ${bandInnerKm * 1000})`
          : sql`true`,
        /*
         * THE two-sided distance constraint. The ring is the pharmacy
         * searching outward; `max_travel_km` is the locum's own standing
         * limit, and it wins. A locum who set 15 km is never messaged about a
         * 40 km shift, however wide the ring has grown.
         *
         * Left as a plain comparison on purpose: the radius is a COLUMN, so
         * ST_DWithin could not use the index for it either. Sequenced after
         * the band above, it only ever runs on rows the index already kept.
         */
        sql`${distanceM} <= ${locumProfiles.maxTravelKm} * 1000`,
        input.ring === 0
          ? sql`exists (
              select 1 from ${favouriteLocums} f
              join ${shifts} s on s.pharmacy_id = f.pharmacy_id
              where s.id = ${input.shiftId} and f.locum_id = ${locumProfiles.userId}
            )`
          : /*
             * Favourites are excluded from later rings rather than merely
             * deduplicated by the caller. They were told first, on purpose;
             * including them again in ring 2 would send a second message about
             * the same shift to the person most likely to already be deciding.
             */
            sql`not exists (
              select 1 from ${favouriteLocums} f
              join ${shifts} s on s.pharmacy_id = f.pharmacy_id
              where s.id = ${input.shiftId} and f.locum_id = ${locumProfiles.userId}
            )`,
        excluded.length === 0
          ? sql`true`
          : sql`${locumProfiles.userId} not in ${excluded}`,
        /*
         * Never offer a shift to someone already committed elsewhere at that
         * time. This is not politeness: a double-booked locum who accepts has
         * to cancel one of them, and §9 charges for a late cancellation. The
         * platform would be manufacturing the very no-show it penalises.
         */
        sql`not exists (
          select 1 from ${bookings} b
          join ${shifts} other on other.id = b.shift_id
          where b.locum_id = ${locumProfiles.userId}
            and b.status = 'confirmed'
            and other.starts_at < ${shift.endsAt.toISOString()}::timestamptz
            and other.ends_at > ${shift.startsAt.toISOString()}::timestamptz
        )`,
        // Nor to someone who has already applied — they know about it.
        sql`not exists (
          select 1 from ${bookings} b
          where b.shift_id = ${input.shiftId}
            and b.locum_id = ${locumProfiles.userId}
        )`,
      ),
    )
    /*
     * §7 reliability first, distance second.
     *
     * Deliberately not distance-first. The manager's problem is not "who is
     * nearest", it is "who will actually turn up" — a no-show at 08:00 means a
     * pharmacy that legally cannot trade. Someone six kilometres further away
     * with a record of completing shifts is the better answer, and the spec
     * names distance AND reliability together for the expansion.
     *
     * `no_shows` descending-worst-last rather than a computed score, because
     * the §7 tier is a disclosure rule for humans and this is an ordering; tying
     * them would let a change to one silently reorder the other.
     */
    .orderBy(
      sql`${locumProfiles.noShows} asc`,
      sql`${locumProfiles.completedShifts} desc`,
      sql`${distanceM} asc`,
    )
    .limit(limit);

  return rows.map((row) => ({
    locumId: row.locumId,
    distanceKm: Math.round((Number(row.distanceM) / 1000) * 10) / 10,
    ring: input.ring,
    completedShifts: row.completedShifts,
    noShows: row.noShows,
  }));
}

/**
 * When the next ring may be released, or `undefined` if there is none.
 *
 * Returned rather than scheduled so the decision to escalate stays with the
 * caller — the worker checks whether the shift is still open first, and a
 * module that scheduled its own follow-up would keep escalating a shift that
 * was filled a minute later.
 */
export function nextRingDueAt(
  ring: number,
  from: Date,
  escalationMinutes: number = RING_ESCALATION_MINUTES,
): Date | undefined {
  if (ring >= RING_BANDS_KM.length) return undefined;
  return new Date(from.getTime() + escalationMinutes * 60_000);
}

/** The last ring index that exists. Ring 0 is favourites. */
export const LAST_RING = RING_BANDS_KM.length;

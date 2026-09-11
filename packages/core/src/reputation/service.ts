import { and, asc, eq, sql } from "drizzle-orm";
import {
  bookings,
  locumProfiles,
  pharmacyMembers,
  ratings,
  reputationSnapshots,
  shifts,
  type Database,
} from "@locum/db";
import { DomainError } from "../errors";
import {
  computeReputation,
  ratingsForDisclosure,
  type Reputation,
  type ReputationDisplay,
} from "./tiers";

/**
 * §7 — reading and writing reputation.
 *
 * The rules live in tiers.ts as a pure function; this file supplies it with
 * real rows and enforces who may rate whom.
 */

/** Radius used to size the plausible rater pool. See `plausibleRaterPool`. */
export const DENSITY_RADIUS_KM = 25;

export interface RateInput {
  readonly bookingId: string;
  readonly raterId: string;
  readonly score: number;
  readonly comment?: string;
}

/**
 * Records one participant's rating of the other.
 *
 * Only after the shift has ended. Rating a shift that has not happened is
 * rating an expectation, and — more practically — a manager able to rate
 * before the shift has a lever over someone who has not worked yet.
 */
export async function rateBooking(
  db: Database,
  input: RateInput,
): Promise<{ ratingId: string }> {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new DomainError("INVALID_RATING", "A rating must be a whole number from 1 to 5", {
      score: input.score,
    });
  }

  const rows = await db.execute<{
    booking_status: string;
    locum_id: string;
    shift_ends_at: string;
    pharmacy_id: string;
    is_manager: boolean;
  }>(sql`
    select b.status::text as booking_status,
           b.locum_id     as locum_id,
           s.ends_at      as shift_ends_at,
           s.pharmacy_id  as pharmacy_id,
           exists (
             select 1 from pharmacy_members pm
              where pm.pharmacy_id = s.pharmacy_id
                and pm.user_id = ${input.raterId}
           ) as is_manager
      from bookings b
      join shifts s on s.id = b.shift_id
     where b.id = ${input.bookingId}
  `);

  const row = [...rows][0];
  if (!row) {
    throw new DomainError("BOOKING_NOT_FOUND", "Booking not found", {
      bookingId: input.bookingId,
    });
  }

  const isLocum = row.locum_id === input.raterId;
  if (!isLocum && !row.is_manager) {
    throw new DomainError(
      "NOT_BOOKING_PARTICIPANT",
      "You are not a participant in this booking",
      { bookingId: input.bookingId },
    );
  }

  if (new Date(row.shift_ends_at) > new Date()) {
    throw new DomainError(
      "SHIFT_NOT_FINISHED",
      "You can rate this shift once it has ended",
      { bookingId: input.bookingId },
    );
  }

  /*
   * A cancelled booking has nothing to rate — nobody worked. §9 already
   * handles the accountability side of a late cancellation with the R10
   * charge, and letting it *also* become a one-star rating would punish the
   * same event twice, on a signal other pharmacies then read as work quality.
   */
  if (row.booking_status.startsWith("cancelled")) {
    throw new DomainError(
      "BOOKING_NOT_RATEABLE",
      "A cancelled shift cannot be rated",
      { bookingId: input.bookingId, status: row.booking_status },
    );
  }

  /*
   * The ratee is the other party. For a locum rating the pharmacy, the subject
   * is the pharmacy's *primary member* — ratings are keyed to users, and a
   * pharmacy is not one. That is a modelling compromise worth naming: it means
   * a pharmacy's reputation follows its primary contact, and re-assigning that
   * contact moves the history with them.
   */
  const rateeId = isLocum ? await primaryMemberOf(db, row.pharmacy_id) : row.locum_id;
  if (!rateeId) {
    throw new DomainError("BOOKING_NOT_RATEABLE", "This pharmacy has no contact to rate", {
      bookingId: input.bookingId,
    });
  }

  const [created] = await db
    .insert(ratings)
    .values({
      bookingId: input.bookingId,
      raterId: input.raterId,
      rateeId,
      score: input.score,
      ...(input.comment !== undefined && { comment: input.comment }),
    })
    .onConflictDoNothing({ target: [ratings.bookingId, ratings.raterId] })
    .returning({ id: ratings.id });

  if (!created) {
    /*
     * `ratings_booking_rater_key` already held one. Reported rather than
     * silently overwritten: a rating someone can revise after seeing its
     * effect is a rating they can use to negotiate.
     */
    throw new DomainError("ALREADY_RATED", "You have already rated this shift", {
      bookingId: input.bookingId,
    });
  }

  return { ratingId: created.id };
}

async function primaryMemberOf(db: Database, pharmacyId: string): Promise<string | null> {
  const [member] = await db
    .select({ userId: pharmacyMembers.userId })
    .from(pharmacyMembers)
    .where(eq(pharmacyMembers.pharmacyId, pharmacyId))
    .orderBy(sql`${pharmacyMembers.isPrimary} desc`, asc(pharmacyMembers.createdAt))
    .limit(1);
  return member?.userId ?? null;
}

/**
 * Everything the §7 rules need about one subject.
 *
 * `plausibleRaterPool` is the density input, and it is deliberately a count of
 * who *could* have rated them rather than who did: the question the
 * anonymisation rules are asking is "how large is the crowd a rater is hiding
 * in", and that crowd is the local market, not the subset that has already
 * spoken.
 */
export async function getReputation(
  db: Database,
  subjectId: string,
): Promise<Reputation> {
  const [profile] = await db
    .select({
      completedShifts: locumProfiles.completedShifts,
      noShows: locumProfiles.noShows,
      baseLocation: locumProfiles.baseLocation,
    })
    .from(locumProfiles)
    .where(eq(locumProfiles.userId, subjectId))
    .limit(1);

  const received = await db
    .select({
      raterId: ratings.raterId,
      score: ratings.score,
      createdAt: ratings.createdAt,
    })
    .from(ratings)
    .where(eq(ratings.rateeId, subjectId))
    .orderBy(asc(ratings.createdAt));

  const completedShifts = profile?.completedShifts ?? 0;
  const noShows = profile?.noShows ?? 0;
  const distinctRaters = new Set(received.map((r) => r.raterId)).size;

  const [snapshot] = await db
    .select({
      publishedRatingCount: reputationSnapshots.publishedRatingCount,
      publishedDisplay: reputationSnapshots.publishedDisplay,
    })
    .from(reputationSnapshots)
    .where(eq(reputationSnapshots.subjectId, subjectId))
    .limit(1);

  /*
   * §7 delta protection (tiers.ts `ratingsForDisclosure`). Without a prior
   * snapshot there is no earlier state to diff a new rating against, so the
   * first-ever publish is unrestricted; after that, a tier is only
   * recomputed once enough new ratings have arrived to move it as a group.
   */
  const toDisclose = snapshot
    ? ratingsForDisclosure(received, snapshot.publishedRatingCount)
    : received;

  if (toDisclose === undefined) {
    // Too few new ratings since the last publish. Republish the PREVIOUS
    // display unchanged; only the always-safe counts (never attributable to
    // any one rater) are allowed to move live.
    return {
      display: JSON.parse(snapshot!.publishedDisplay) as ReputationDisplay,
      ratingCount: received.length,
      distinctRaters,
      completedShifts,
      noShows,
    };
  }

  const plausibleRaterPool = profile?.baseLocation
    ? await countNearbyPharmacies(db, profile.baseLocation)
    : /*
       * No base location means no way to size the local market, and an unknown
       * density must fail closed. Zero drives `market_too_thin`, which
       * withholds — the alternative, assuming a dense market, would expose
       * raters precisely where we know least about who they are.
       */
      0;

  const reputation = computeReputation({
    ratings: toDisclose,
    completedShifts,
    noShows,
    plausibleRaterPool,
  });

  await db
    .insert(reputationSnapshots)
    .values({
      subjectId,
      publishedRatingCount: received.length,
      publishedDisplay: JSON.stringify(reputation.display),
    })
    .onConflictDoUpdate({
      target: reputationSnapshots.subjectId,
      set: {
        publishedRatingCount: received.length,
        publishedDisplay: JSON.stringify(reputation.display),
        updatedAt: sql`now()`,
      },
    });

  return reputation;
}

async function countNearbyPharmacies(
  db: Database,
  location: { lng: number; lat: number },
): Promise<number> {
  const rows = await db.execute<{ pool: number }>(sql`
    select count(distinct s.pharmacy_id)::int as pool
      from shifts s
     where ST_DWithin(
             s.location,
             ST_SetSRID(ST_MakePoint(${location.lng}, ${location.lat}), 4326)::geography,
             ${DENSITY_RADIUS_KM * 1000}
           )
  `);
  return [...rows][0]?.pool ?? 0;
}

/**
 * Completed bookings the caller could still rate and has not.
 *
 * Covers BOTH sides. The first version keyed only on `bookings.locum_id`,
 * which meant a manager was never prompted — and a "unified" two-sided
 * reputation where only one side is ever asked collects ratings in one
 * direction and calls it symmetry. It is exactly the drift §7's first word
 * exists to prevent, and it arrived within an hour of writing that word down.
 *
 * Drives one prompt, once. A system that nags collects ratings given to stop
 * the nagging, which is worse than no ratings at all.
 */
export async function unratedBookingsFor(
  db: Database,
  userId: string,
  limit = 20,
): Promise<Array<{ bookingId: string; endedAt: Date }>> {
  const rows = await db
    .select({ bookingId: bookings.id, endedAt: shifts.endsAt })
    .from(bookings)
    .innerJoin(shifts, eq(shifts.id, bookings.shiftId))
    .where(
      and(
        // The locum who worked it, or anyone at the pharmacy that hosted it.
        sql`(
          ${bookings.locumId} = ${userId}
          or exists (
            select 1 from ${pharmacyMembers} pm
             where pm.pharmacy_id = ${shifts.pharmacyId}
               and pm.user_id = ${userId}
          )
        )`,
        eq(bookings.status, "completed"),
        sql`${shifts.endsAt} < now()`,
        sql`not exists (
          select 1 from ${ratings} r
           where r.booking_id = ${bookings.id}
             and r.rater_id = ${userId}
        )`,
      ),
    )
    .orderBy(asc(shifts.endsAt))
    .limit(limit);

  return rows;
}

/**
 * §7 — unified reputation tiers with density-aware anonymization.
 *
 * §7 is one line in the spec, so the reasoning below is an interpretation and
 * is written out rather than assumed. Three words are doing the work.
 *
 * ## "unified"
 *
 * One tier vocabulary, applied to both sides. A pharmacy rates a locum and a
 * locum rates a pharmacy, and both are shown on the same scale. The
 * alternative — rating only locums — is the arrangement every staffing
 * marketplace drifts into, and it is how the supply side learns that the
 * platform is something done *to* them. Locums are the scarce side here; a
 * pharmacy with a reputation for cancelling at short notice is exactly the
 * thing a relief pharmacist most wants to know and currently learns only by
 * word of mouth.
 *
 * ## "tiers", not scores
 *
 * The stored rating is 1–5, but nothing displays a mean. A tier is a coarse
 * band, and coarseness is itself a privacy control: on a decimal average, one
 * new rating visibly moves the number, and the subject can solve for what it
 * was. A band absorbs it. Bands are also more honest about what five ratings
 * can support — the difference between 4.2 and 4.4 is noise, and displaying it
 * invites people to act on noise.
 *
 * ## "density-aware anonymization"
 *
 * This is the hard part, and it is a real problem in this market rather than a
 * theoretical one. Locum Planner launches in Johannesburg with a thin two-sided
 * pool. If a pharmacy has hosted three locums ever and its rating drops the
 * week after a bad shift, the manager knows precisely who did it — and that
 * locum needs work from that pharmacy again next month. An honest rating system
 * that exposes its raters produces dishonest ratings, and then a tier nobody
 * should rely on.
 *
 * Four controls, each covering something the others do not:
 *
 *   1. **k-anonymity** — a tier appears only above a floor of *distinct*
 *      counterparties.
 *   2. **Dominance** — a pharmacy that booked the same locum twelve times is
 *      one opinion, not twelve. No single rater may carry the tier.
 *   3. **Delta protection** — the one usually missed. Even with a hundred
 *      raters, an aggregate that updates the instant rating 101 lands lets the
 *      subject compute rating 101 exactly. So a tier is only recomputed once
 *      enough new ratings have accumulated to move it as a group.
 *   4. **Local density** — in a suburb with four pharmacies, three distinct
 *      raters is not anonymity. Where the pool is too small for any floor to
 *      hide a rater, nothing is shown at all; above that line the floor rises
 *      with the pool, because a bigger crowd is where a bigger k can actually
 *      be obtained. (The tempting inverse — demand *more* raters in a sparse
 *      market — is unworkable, and `computeReputation` explains why.)
 *
 * Control 4 has a consequence worth stating plainly rather than engineering
 * around: **in a genuinely thin market, reputation cannot be both useful and
 * safe.** This module chooses safe. A withheld tier is a product limitation; a
 * tier that identifies its raters is a trap for the person who trusted it.
 */

export type Tier = "excellent" | "reliable" | "mixed" | "concerning";

export type ReputationDisplay =
  | { readonly kind: "tier"; readonly tier: Tier }
  /** Not enough independent evidence to say anything without exposing someone. */
  | { readonly kind: "withheld"; readonly reason: WithheldReason };

export type WithheldReason =
  | "too_few_raters"
  | "dominated_by_one_rater"
  | "market_too_thin"
  | "no_ratings";

export interface ReputationInput {
  /** Every rating for this subject, oldest first. */
  readonly ratings: ReadonlyArray<{
    readonly raterId: string;
    readonly score: number;
    readonly createdAt: Date;
  }>;
  /** Completed shifts and no-shows carry more signal than opinion does. */
  readonly completedShifts: number;
  readonly noShows: number;
  /**
   * How many counterparties could plausibly have rated this subject — nearby
   * pharmacies for a locum, nearby locums for a pharmacy. The "density" in
   * density-aware.
   */
  readonly plausibleRaterPool: number;
}

export interface Reputation {
  readonly display: ReputationDisplay;
  /** Always safe to show: a count is not attributable to anyone. */
  readonly ratingCount: number;
  readonly distinctRaters: number;
  readonly completedShifts: number;
  readonly noShows: number;
}

/**
 * Absolute floor on distinct raters.
 *
 * Three, not two. With two, a subject who knows one rater's opinion knows the
 * other's by subtraction — and in this market they very often do know one,
 * because they have spoken to both of them.
 */
export const MIN_DISTINCT_RATERS = 3;

/**
 * No single rater may account for more than this share of a subject's ratings.
 *
 * A pharmacy that books the same locum every Saturday generates a dozen
 * ratings from one opinion. Half is deliberately generous: stricter would
 * withhold tiers for exactly the regular working relationships this product is
 * trying to create.
 */
export const MAX_SINGLE_RATER_SHARE = 0.5;

/**
 * Ceiling on the density-scaled rater floor.
 *
 * Without a cap, a dense metro would demand an unreachable number of distinct
 * raters and withhold tiers permanently in exactly the market where the
 * product is busiest — protecting nobody, because a tier nobody ever sees
 * carries no information to leak.
 */
export const MAX_REQUIRED_RATERS = 5;

/**
 * Below this many plausible counterparties, the local market is too thin for
 * any floor to hide a rater, and nothing is shown.
 *
 * Ten is a judgement, not a derivation, and it is the number most worth
 * revisiting with real data — the right value depends on how concentrated
 * bookings turn out to be in practice, which cannot be known before launch.
 */
export const MIN_PLAUSIBLE_RATER_POOL = 10;

/**
 * A tier is recomputed only when this many new ratings have arrived since the
 * last one it was computed from.
 *
 * This is delta protection. With batch size 1 the tier is a live readout of
 * the newest rating; at 2 a subject watching for a change cannot attribute it
 * to either of the two people who caused it.
 */
export const DISCLOSURE_BATCH = 2;

/**
 * Computes what may be shown about a subject.
 *
 * Pure: no database, no clock, no I/O. The privacy rules are the part of this
 * system most likely to be quietly weakened by a future change, and a pure
 * function is one that can be exhaustively tested without fixtures.
 */
export function computeReputation(input: ReputationInput): Reputation {
  const distinct = new Set(input.ratings.map((r) => r.raterId));
  const base = {
    ratingCount: input.ratings.length,
    distinctRaters: distinct.size,
    completedShifts: input.completedShifts,
    noShows: input.noShows,
  };

  const withheld = (reason: WithheldReason): Reputation => ({
    ...base,
    display: { kind: "withheld", reason },
  });

  if (input.ratings.length === 0) return withheld("no_ratings");

  /*
   * Density is checked first, and checked even when there are many ratings.
   * A subject with twenty ratings drawn from a pool of four pharmacies is
   * *less* protected than one with five ratings from fifty — the ratings all
   * came from a group small enough to reason about.
   */
  if (input.plausibleRaterPool < MIN_PLAUSIBLE_RATER_POOL) {
    return withheld("market_too_thin");
  }

  /*
   * The floor rises with pool size, and the direction is worth being careful
   * about — the first version of this scaled the other way, on the intuition
   * that a sparse market is more dangerous and should therefore demand more
   * raters. That is half right and wholly unworkable: a sparse market *is*
   * more dangerous, which is exactly why it can never supply the extra raters
   * the intuition asks for. Demanding more there withholds forever.
   *
   * The two dangers are handled separately. A pool too small for any k to
   * protect anyone is refused outright above (`market_too_thin`). Above that
   * line, a larger k is strictly better protection, and a larger pool is where
   * a larger k is actually obtainable — so the floor asks for as much as the
   * market can reasonably give, capped so that a busy suburb does not withhold
   * tiers indefinitely.
   */
  const requiredRaters = Math.min(
    MAX_REQUIRED_RATERS,
    Math.max(MIN_DISTINCT_RATERS, Math.ceil(input.plausibleRaterPool / 20)),
  );
  if (distinct.size < requiredRaters) return withheld("too_few_raters");

  const counts = new Map<string, number>();
  for (const rating of input.ratings) {
    counts.set(rating.raterId, (counts.get(rating.raterId) ?? 0) + 1);
  }
  const largestShare = Math.max(...counts.values()) / input.ratings.length;
  if (largestShare > MAX_SINGLE_RATER_SHARE) {
    return withheld("dominated_by_one_rater");
  }

  return { ...base, display: { kind: "tier", tier: tierFor(input) } };
}

/**
 * Which ratings a tier may be computed from, given the last batch it was
 * published at.
 *
 * Returns the ratings to use, or `undefined` when too few have arrived since
 * to refresh without exposing them individually. Callers publish the previous
 * tier unchanged in that case — a slightly stale tier is a much smaller
 * problem than a live one.
 */
export function ratingsForDisclosure<T>(
  ratings: readonly T[],
  publishedAtCount: number,
  batch = DISCLOSURE_BATCH,
): readonly T[] | undefined {
  if (ratings.length - publishedAtCount < batch) return undefined;
  return ratings;
}

/**
 * The tier bands.
 *
 * No-shows are weighted far more heavily than opinion, and deliberately so.
 * A three-star rating means someone found the shift disappointing; a no-show
 * means a pharmacy could not legally dispense that day. Those are not points
 * on the same scale, and averaging them would let a run of pleasant reviews
 * paper over the one failure the product exists to prevent.
 */
function tierFor(input: ReputationInput): Tier {
  const mean =
    input.ratings.reduce((total, r) => total + r.score, 0) / input.ratings.length;

  const attended = input.completedShifts + input.noShows;
  const noShowRate = attended === 0 ? 0 : input.noShows / attended;

  // One no-show in a short history is a red flag on its own. It stops being
  // one only once there is a long record around it.
  if (input.noShows > 0 && noShowRate > 0.1) return "concerning";
  if (mean < 3) return "concerning";
  if (mean < 4) return "mixed";
  if (mean < 4.6 || input.completedShifts < 5) return "reliable";
  return "excellent";
}

/** What a subject or viewer is told when a tier is withheld. */
export function explainWithheld(reason: WithheldReason): string {
  switch (reason) {
    case "no_ratings":
      return "No ratings yet.";
    case "too_few_raters":
      return "Not enough ratings yet to show a rating without identifying who left it.";
    case "dominated_by_one_rater":
      return "Ratings so far come mostly from one working relationship.";
    case "market_too_thin":
      return "Too few pharmacies nearby to show a rating anonymously.";
  }
}

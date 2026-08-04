export type Tier = "excellent" | "reliable" | "mixed" | "concerning";

export interface Reputation {
  display:
    | { kind: "tier"; tier: Tier }
    | { kind: "withheld"; reason: string };
  ratingCount: number;
  distinctRaters: number;
  completedShifts: number;
  noShows: number;
}

const TIER_LABEL: Record<Tier, string> = {
  excellent: "Excellent",
  reliable: "Reliable",
  mixed: "Mixed",
  concerning: "Needs a look",
};

const TIER_TONE: Record<Tier, string> = {
  excellent: "badge badge-ok",
  reliable: "badge badge-ok",
  mixed: "badge badge-warn",
  concerning: "badge badge-danger",
};

const WITHHELD_LABEL: Record<string, string> = {
  no_ratings: "No ratings yet",
  too_few_raters: "Too few ratings to show",
  dominated_by_one_rater: "Mostly one working relationship",
  market_too_thin: "Too few pharmacies nearby to show anonymously",
};

/**
 * §7 — how a tier is displayed, and how a withheld one is.
 *
 * A withheld tier renders as an explanation, never as a blank or a neutral
 * placeholder. Two reasons. A blank reads as "not loaded" and a viewer
 * eventually stops noticing it; and "too few ratings to show" is genuinely
 * useful information about a new locum, whereas a grey dash is not.
 *
 * There is deliberately no numeric average anywhere in this component. §7's
 * anonymisation is built on tiers being coarse — a decimal moves visibly when
 * one rating lands, and the subject can solve for it. Rendering a mean here
 * would undo the whole design from the outside.
 */
export function ReputationBadge({ reputation }: { reputation: Reputation }) {
  if (reputation.display.kind === "tier") {
    const { tier } = reputation.display;
    return (
      <span className={TIER_TONE[tier]} title={`${reputation.ratingCount} ratings`}>
        {TIER_LABEL[tier]}
      </span>
    );
  }

  return (
    <span className="hint">
      {WITHHELD_LABEL[reputation.display.reason] ?? "No rating shown"}
    </span>
  );
}

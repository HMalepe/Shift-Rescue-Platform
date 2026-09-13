import { and, eq, sql } from "drizzle-orm";
import { pharmacies, shiftOffers, shifts, type Database } from "@locum/db";
import { sendWhatsAppMessage, type SendDeps } from "../messaging/send";
import { formatShiftStart } from "../messaging/templates";
import {
  LAST_RING,
  MAX_TOTAL_PER_SHIFT,
  nextRingDueAt,
  selectRing,
} from "./rings";

/**
 * §12.3 Phase 3 — turning one ring into messages.
 *
 * `selectRing` decides who; this decides what actually happens to them, and
 * the ordering inside it is the whole point.
 *
 * ## Record the offer BEFORE sending it
 *
 * The insert comes first, and `onConflictDoNothing` on
 * `shift_offers_unique` is what makes the fan-out safe to run twice.
 *
 * The alternative — send, then record — has a failure mode that is invisible
 * and expensive: the send succeeds, the process dies before the insert, the
 * job is retried, and the same pharmacist gets the same offer twice. BullMQ is
 * at-least-once, so this is not hypothetical. Recording first means a crash
 * produces an offer nobody was told about, which is a missed opportunity
 * rather than an unrecallable duplicate message to a real person.
 *
 * The database index is what enforces it, not this code. A row that loses the
 * insert race is simply not sent to.
 */

export interface FanOutDeps extends SendDeps {
  readonly now?: () => Date;
}

export interface FanOutResult {
  readonly shiftId: string;
  readonly ring: number;
  readonly offered: number;
  readonly sent: number;
  readonly suppressed: number;
  readonly failed: number;
  /** When the next ring may run, or undefined when escalation is finished. */
  readonly nextRingAt: Date | undefined;
  readonly nextRing: number | undefined;
  /** Why escalation stopped, when it did. Read by the worker's log. */
  readonly stoppedReason?: "filled" | "budget" | "last_ring";
}

export async function fanOutRing(
  db: Database,
  deps: FanOutDeps,
  input: { shiftId: string; ring: number },
): Promise<FanOutResult> {
  const now = deps.now?.() ?? new Date();

  const empty = (stoppedReason: FanOutResult["stoppedReason"]): FanOutResult => ({
    shiftId: input.shiftId,
    ring: input.ring,
    offered: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    nextRingAt: undefined,
    nextRing: undefined,
    ...(stoppedReason ? { stoppedReason } : {}),
  });

  const [shift] = await db
    .select({
      id: shifts.id,
      status: shifts.status,
      startsAt: shifts.startsAt,
      pharmacyName: pharmacies.name,
      pharmacySuburb: pharmacies.city,
    })
    .from(shifts)
    .innerJoin(pharmacies, eq(pharmacies.id, shifts.pharmacyId))
    .where(eq(shifts.id, input.shiftId))
    .limit(1);

  if (!shift) return empty(undefined);
  if (shift.status !== "open") return empty("filled");

  /*
   * The lifetime budget, checked before selecting rather than after.
   *
   * §11.6 caps spend for the whole platform per day; this caps one shift, and
   * it is the more useful of the two because it fires before the shared budget
   * is damaged. A shift that has already reached sixty people does not need a
   * sixty-first — it needs someone to look at why nobody is accepting.
   */
  const [offeredSoFar] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shiftOffers)
    .where(eq(shiftOffers.shiftId, input.shiftId));

  const alreadyOffered = offeredSoFar?.n ?? 0;
  if (alreadyOffered >= MAX_TOTAL_PER_SHIFT) return empty("budget");

  const previous = await db
    .select({ locumId: shiftOffers.locumId })
    .from(shiftOffers)
    .where(eq(shiftOffers.shiftId, input.shiftId));

  const remaining = MAX_TOTAL_PER_SHIFT - alreadyOffered;

  const candidates = await selectRing(db, {
    shiftId: input.shiftId,
    ring: input.ring,
    excludeLocumIds: previous.map((row) => row.locumId),
    limit: remaining,
  });

  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  let offered = 0;

  for (const candidate of candidates) {
    /*
     * Claim the offer first. A conflict means another worker already has this
     * one — skip without sending, rather than sending and hoping.
     */
    const claimed = await db
      .insert(shiftOffers)
      .values({
        shiftId: input.shiftId,
        locumId: candidate.locumId,
        ring: input.ring,
        distanceM: Math.round(candidate.distanceKm * 1000),
      })
      .onConflictDoNothing({ target: [shiftOffers.shiftId, shiftOffers.locumId] })
      .returning({ id: shiftOffers.id });

    if (claimed.length === 0) continue;
    offered += 1;

    /*
     * Positional variables, in the order submitted to Meta. §11.2 keeps them
     * positional all the way from here rather than as a named record, because
     * the mapping would otherwise be re-derived at the transport edge — and a
     * template that renders the suburb in the date slot is accepted by Twilio,
     * delivered, and nonsense to the reader.
     */
    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "shift_offer",
      userId: candidate.locumId,
      variables: [
        shift.pharmacyName,
        shift.pharmacySuburb ?? "",
        formatShiftStart(shift.startsAt),
        String(candidate.distanceKm),
      ],
    });

    if (outcome.status === "sent" || outcome.status === "deferred") sent += 1;
    else if (outcome.status === "suppressed") suppressed += 1;
    else failed += 1;
  }

  /*
   * Escalation is offered, never scheduled here. The worker re-checks that the
   * shift is still open when the timer fires — a module that scheduled its own
   * follow-up would keep escalating a shift filled a minute later.
   */
  const isLastRing = input.ring >= LAST_RING;
  const nextRingAt = isLastRing ? undefined : nextRingDueAt(input.ring, now);

  return {
    shiftId: input.shiftId,
    ring: input.ring,
    offered,
    sent,
    suppressed,
    failed,
    nextRingAt,
    nextRing: nextRingAt ? input.ring + 1 : undefined,
    ...(isLastRing ? { stoppedReason: "last_ring" as const } : {}),
  };
}

/**
 * Starts the fan-out for a shift — the "Looking for a Locum" toggle.
 *
 * Runs ring 0 synchronously because the spec's whole framing is "the instant a
 * manager toggles". A manager who presses the button and is told "we have
 * notified your six regulars" has been given something; one who is told "we
 * will get to it" has been given a promise, and the fan-out is the feature.
 */
export async function startLookingForLocum(
  db: Database,
  deps: FanOutDeps,
  input: { shiftId: string },
): Promise<FanOutResult> {
  return fanOutRing(db, deps, { shiftId: input.shiftId, ring: 0 });
}

/** Everyone already offered this shift — the exclusion list for later rings. */
export async function offeredLocumIds(
  db: Database,
  shiftId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ locumId: shiftOffers.locumId })
    .from(shiftOffers)
    .where(eq(shiftOffers.shiftId, shiftId));
  return rows.map((row) => row.locumId);
}

/** Offers made for a shift in one ring, for the §12.3 verifier and the UI. */
export async function offersForRing(
  db: Database,
  shiftId: string,
  ring: number,
): Promise<readonly { locumId: string; distanceM: number }[]> {
  return db
    .select({ locumId: shiftOffers.locumId, distanceM: shiftOffers.distanceM })
    .from(shiftOffers)
    .where(and(eq(shiftOffers.shiftId, shiftId), eq(shiftOffers.ring, ring)));
}

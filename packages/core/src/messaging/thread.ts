import { and, asc, eq, sql } from "drizzle-orm";
import { bookings, messages, type Database } from "@locum/db";
import { DomainError } from "../errors";
import { detectDisintermediation } from "./disintermediation";

/**
 * §6 — time-gated in-app messaging between a pharmacy and a locum.
 *
 * Two independent controls, and they are worth keeping separate in the head:
 *
 * **The gate** decides whether a thread is open at all. It is an authorization
 * check and it refuses. A booking creates a reason for these two people to
 * talk; it does not create a permanent channel between them, and a thread that
 * never closes is a thread someone can be harassed through months after a
 * shift they worked once.
 *
 * **The flag** decides whether a delivered message is *interesting*. It never
 * refuses. See disintermediation.ts for why blocking on an unvalidated regex
 * would be the wrong trade.
 *
 * Everything routes through here and never through personal numbers (§10.1):
 * "a manager should never need to give out, or receive, a personal number to
 * complete a booking."
 */

/**
 * How long after a shift ends the thread stays open.
 *
 * Long enough to settle what actually happens after a shift — a missed
 * handover note, a query about hours, a dispute opened the next morning
 * (§7's disputed booking state assumes someone can still talk). Short enough
 * that it is a window and not a permanent line.
 */
export const THREAD_OPEN_AFTER_SHIFT_HOURS = 72;

/**
 * States in which a thread is open.
 *
 * `requested` is included deliberately: a manager needs to ask a question
 * *before* confirming, and requiring confirmation first would push exactly
 * that conversation onto WhatsApp — the behaviour this product exists to
 * replace. The cancelled states are included too, because "why did you
 * cancel?" is a conversation the platform should host rather than exile.
 */
const OPEN_BOOKING_STATES = [
  "requested",
  "confirmed",
  "completed",
  "cancelled_by_locum",
  "cancelled_by_manager",
  "disputed",
  "no_show",
] as const;

export interface PostMessageInput {
  readonly bookingId: string;
  readonly senderId: string;
  readonly body: string;
}

export interface PostedMessage {
  readonly id: string;
  readonly flagged: boolean;
  readonly flagReason: string | null;
}

export interface ThreadDeps {
  readonly now?: () => Date;
  /**
   * Called when a message is flagged, after it has been stored and delivered.
   *
   * An observer rather than a return-path decision, so that no future caller
   * can be tempted to await it and withhold the message. §14: the
   * false-positive rate is meaningless until a human labels the corpus, and
   * until then a flag is a note for a reviewer, not a verdict.
   */
  readonly onFlagged?: (context: {
    readonly messageId: string;
    readonly bookingId: string;
    readonly senderId: string;
    readonly rules: readonly string[];
  }) => void;
}

export async function postMessage(
  db: Database,
  deps: ThreadDeps,
  input: PostMessageInput,
): Promise<PostedMessage> {
  const now = deps.now?.() ?? new Date();

  /*
   * One query for the gate: the booking, its shift's end time, and whether the
   * sender is either the locum or a member of the owning pharmacy. Splitting
   * these into three round trips would also leave a window in which the
   * booking is read as open and then cancelled before the insert — small, but
   * free to close by reading it all at once.
   */
  const rows = await db.execute<{
    booking_status: string;
    locum_id: string;
    /*
     * A string, not a Date. `db.execute` bypasses the schema-aware decoding
     * that drizzle's query builder applies, so a timestamptz comes back in
     * whatever form the driver produced. Typing it honestly and converting
     * once below beats declaring `Date` and discovering at runtime that
     * `.getTime` is not a function.
     */
    shift_ends_at: string;
    is_manager: boolean;
  }>(sql`
    select b.status        as booking_status,
           b.locum_id      as locum_id,
           s.ends_at       as shift_ends_at,
           exists (
             select 1
               from pharmacy_members pm
              where pm.pharmacy_id = s.pharmacy_id
                and pm.user_id = ${input.senderId}
           )               as is_manager
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

  const isParticipant = row.locum_id === input.senderId || row.is_manager;
  if (!isParticipant) {
    /*
     * Same error whether the booking is missing or merely not yours would be
     * better still, but BOOKING_NOT_FOUND is already thrown above and
     * collapsing them would cost the legitimate 404 its meaning. The booking
     * id is a UUID; enumerating them is not a practical attack.
     */
    throw new DomainError(
      "NOT_BOOKING_PARTICIPANT",
      "You are not a participant in this booking",
      { bookingId: input.bookingId },
    );
  }

  if (!(OPEN_BOOKING_STATES as readonly string[]).includes(row.booking_status)) {
    throw new DomainError(
      "THREAD_CLOSED",
      `Messaging is closed for a booking in state '${row.booking_status}'`,
      { bookingId: input.bookingId, status: row.booking_status },
    );
  }

  const closesAt = new Date(
    new Date(row.shift_ends_at).getTime() +
      THREAD_OPEN_AFTER_SHIFT_HOURS * 3_600_000,
  );
  if (now > closesAt) {
    throw new DomainError(
      "THREAD_CLOSED",
      "Messaging for this shift closed 72 hours after it ended",
      { bookingId: input.bookingId, closedAt: closesAt.toISOString() },
    );
  }

  /*
   * Detection runs on the body that is about to be stored, and the body is
   * stored unmodified. No redaction: a reviewer adjudicating a flag needs to
   * read what was actually said, and a recipient who received a mangled
   * message has been silently failed by a regex nobody has validated yet.
   */
  const detection = detectDisintermediation(input.body);

  const [inserted] = await db
    .insert(messages)
    .values({
      bookingId: input.bookingId,
      senderId: input.senderId,
      body: input.body,
      flaggedDisintermediation: detection.flagged,
      flagReason: detection.reason,
    })
    .returning({ id: messages.id });

  if (detection.flagged) {
    deps.onFlagged?.({
      messageId: inserted!.id,
      bookingId: input.bookingId,
      senderId: input.senderId,
      rules: detection.signals.map((signal) => signal.rule),
    });
  }

  return {
    id: inserted!.id,
    flagged: detection.flagged,
    flagReason: detection.reason,
  };
}

export interface ThreadMessage {
  readonly id: string;
  readonly senderId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * Reads a thread.
 *
 * Note what is absent from the projection: `flagged_disintermediation` and
 * `flag_reason` are not returned. A participant must not be able to probe
 * which phrasings trip the detector — that turns the review queue into a
 * tutorial for evading it. The flags are for the admin queue, which is a
 * different query with a different audience.
 */
export async function readThread(
  db: Database,
  input: { readonly bookingId: string; readonly readerId: string },
): Promise<ThreadMessage[]> {
  const [booking] = await db
    .select({ locumId: bookings.locumId, shiftId: bookings.shiftId })
    .from(bookings)
    .where(eq(bookings.id, input.bookingId))
    .limit(1);

  if (!booking) {
    throw new DomainError("BOOKING_NOT_FOUND", "Booking not found", {
      bookingId: input.bookingId,
    });
  }

  const permitted = await db.execute<{ ok: boolean }>(sql`
    select (
      ${booking.locumId} = ${input.readerId}
      or exists (
        select 1
          from pharmacy_members pm
          join shifts s on s.pharmacy_id = pm.pharmacy_id
         where s.id = ${booking.shiftId}
           and pm.user_id = ${input.readerId}
      )
    ) as ok
  `);

  if (![...permitted][0]?.ok) {
    throw new DomainError(
      "NOT_BOOKING_PARTICIPANT",
      "You are not a participant in this booking",
      { bookingId: input.bookingId },
    );
  }

  return db
    .select({
      id: messages.id,
      senderId: messages.senderId,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.bookingId, input.bookingId))
    .orderBy(asc(messages.createdAt));
}

export interface FlaggedMessage {
  readonly id: string;
  readonly bookingId: string | null;
  readonly senderId: string;
  readonly body: string;
  readonly flagReason: string | null;
  readonly createdAt: Date;
}

/**
 * The admin review queue (§6/§14).
 *
 * This is where a human turns flags into labels, and those labels are the only
 * thing that will ever make the false-positive rate a real number rather than
 * a property of whatever generated the corpus.
 */
export async function listFlaggedMessages(
  db: Database,
  limit = 100,
): Promise<FlaggedMessage[]> {
  return db
    .select({
      id: messages.id,
      bookingId: messages.bookingId,
      senderId: messages.senderId,
      body: messages.body,
      flagReason: messages.flagReason,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.flaggedDisintermediation, true)))
    .orderBy(asc(messages.createdAt))
    .limit(limit);
}

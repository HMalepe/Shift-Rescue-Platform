import { and, asc, eq, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { users, whatsappMessageLog, type Database, type Executor } from "@locum/db";
import { templateFor, type MessageType } from "./templates";
import type { SendDeps } from "./send";

/**
 * §4.4 — draining the quiet-hours backlog.
 *
 * `sendWhatsAppMessage` does not drop a message that lands inside quiet hours;
 * it writes a row with `status = 'queued'` and `scheduled_for = 07:00` and
 * returns. Something has to come back at 07:00 and actually send it. That is
 * this file. `apps/worker` is only the scheduler around it — the logic lives
 * here so it can be tested against a real database without Redis, and so a
 * second consumer (an admin "flush now" button, a one-off script) cannot
 * reimplement the claim protocol slightly differently.
 *
 * The whole design turns on one fact: **a WhatsApp send is not idempotent.**
 * Twilio's message API has no idempotency key, so a message sent twice is
 * charged twice and read by a human twice. Every decision below is downstream
 * of that.
 */

/** Identifies which worker process holds a claim; surfaces in stall triage. */
export type WorkerId = string;

export interface DrainResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface DrainDeps extends SendDeps {
  readonly workerId: WorkerId;
}

/**
 * How long a claim may sit unfinished before it is reported as stalled.
 *
 * Not a lease. Nothing reclaims these automatically — see `findStalledSends`.
 */
export const STALL_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Claims and sends everything due.
 *
 * Returns counts rather than rows: the caller is a scheduled job whose useful
 * output is metrics, and returning message bodies from a batch job is how PII
 * ends up in log aggregation.
 */
export async function drainDeferredMessages(
  db: Database,
  deps: DrainDeps,
  batchSize = 50,
): Promise<DrainResult> {
  const now = deps.now?.() ?? new Date();
  const claimed = await claimDueMessages(db, deps.workerId, now, batchSize);

  const result = { claimed: claimed.length, sent: 0, failed: 0, skipped: 0 };

  for (const row of claimed) {
    const outcome = await sendClaimed(db, deps, row, now);
    result[outcome] += 1;
  }

  return result;
}

interface ClaimedMessage {
  readonly id: string;
  readonly userId: string | null;
  readonly templateType: string | null;
  readonly variables: string[] | null;
}

/**
 * Takes exclusive ownership of due rows.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes running more than one worker safe.
 * Two workers polling the same due-set is the *normal* state of any deployment
 * with more than one process, and without the skip-locked claim both would
 * read the same rows and both would send. `SKIP LOCKED` also means the second
 * worker steps over contended rows and gets on with other work instead of
 * serialising behind the first — at 07:00, when the entire night's backlog
 * comes due at once, that is the difference between a drain that parallelises
 * and one that does not.
 *
 * ## Why this is a MATERIALIZED CTE and not `where id in (select ...)`
 *
 * It was the subquery form first, and that form is silently wrong. Postgres
 * flattens `IN (subquery)` into a semi-join and *rescans the subquery once per
 * outer row*:
 *
 *     Update on whatsapp_message_log
 *       ->  Nested Loop Semi Join
 *             ->  Seq Scan on whatsapp_message_log
 *             ->  Subquery Scan on "ANY_subquery"
 *                   ->  Limit  ->  LockRows  ->  Sort
 *
 * Each rescan locks and returns a *fresh* batch, so `LIMIT 3` against six due
 * rows claimed all six. Nothing about the result looks wrong from the outside
 * — the messages all send, exactly once, in the right order — which is what
 * makes it worth a paragraph. The damage shows up only at 07:00, when the
 * batch limit that was meant to pace the backlog against Twilio's rate limits
 * turns out never to have limited anything, and one statement claims and
 * serially sends the entire night's queue.
 *
 * A CTE fixes it: the plan becomes `CTE due -> Limit -> LockRows` evaluated
 * once, hash-joined to the update. The explicit `MATERIALIZED` is belt and
 * braces rather than the load-bearing part — Postgres 12+ inlines
 * single-reference CTEs by default, but never one containing `FOR UPDATE`, so
 * dropping the keyword here still produces a single evaluation (verified by
 * EXPLAIN, not assumed). It stays because the correctness of this statement
 * depends on single evaluation and nothing else in the SQL says so out loud.
 */
export async function claimDueMessages(
  db: Executor,
  workerId: WorkerId,
  now: Date,
  batchSize: number,
): Promise<ClaimedMessage[]> {
  const rows = await db.execute<{
    id: string;
    user_id: string | null;
    template_type: string | null;
    variables: string[] | null;
  }>(sql`
    with due as materialized (
      select id
        from ${whatsappMessageLog}
       where status = 'queued'
         and scheduled_for is not null
         and scheduled_for <= ${now.toISOString()}::timestamptz
         and claimed_at is null
       order by scheduled_for
       for update skip locked
       limit ${batchSize}
    )
    update ${whatsappMessageLog} as m
       set claimed_at = ${now.toISOString()}::timestamptz, claimed_by = ${workerId}
      from due
     where m.id = due.id
    returning m.id, m.user_id, m.template_type, m.variables
  `);

  return [...rows].map((row) => ({
    id: row.id,
    userId: row.user_id,
    templateType: row.template_type,
    variables: row.variables,
  }));
}

async function sendClaimed(
  db: Database,
  deps: DrainDeps,
  row: ClaimedMessage,
  now: Date,
): Promise<"sent" | "failed" | "skipped"> {
  if (!row.userId || !row.templateType) {
    await markFailed(db, row.id, "malformed_queue_row", now);
    return "failed";
  }

  const spec = templateFor(row.templateType as MessageType);

  /*
   * Consent is re-checked at send time, not trusted from the deferral.
   *
   * Hours passed between the two. A user who texted STOP at 23:00 must not
   * receive the 07:00 backlog — that is precisely the window in which someone
   * opts out, and honouring only the consent state captured at composition
   * time would send to them anyway. §11.4's opt-out is unconditional.
   */
  const [user] = await db
    .select({
      phone: users.phone,
      disabledAt: users.disabledAt,
      optInAt: users.whatsappOptInAt,
      optOutAt: users.whatsappOptOutAt,
    })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);

  const consentWithdrawn =
    !user ||
    user.disabledAt !== null ||
    !user.phone ||
    !user.optInAt ||
    (user.optOutAt !== null && user.optOutAt.getTime() > user.optInAt.getTime());

  if (consentWithdrawn) {
    /*
     * Suppressed, not failed. A message we chose not to send is not an error,
     * and counting it as one would make the failure metric fire on a working
     * opt-out.
     */
    await db
      .update(whatsappMessageLog)
      .set({ status: "failed", errorCode: "consent_withdrawn", statusUpdatedAt: now })
      .where(eq(whatsappMessageLog.id, row.id));
    return "skipped";
  }

  try {
    const result = await deps.sender.sendTemplate({
      to: user.phone!,
      templateName: spec.templateName,
      variables: row.variables ?? [],
    });

    /*
     * The claimed row is updated in place rather than a new row being
     * inserted. `twilio_sid` is the §11.5 dedupe key, and the placeholder
     * `deferred:<uuid>` written at composition time is replaced by the real
     * SID here — so the delivery-status webhook that arrives moments later
     * finds this row instead of creating an orphan.
     */
    await db
      .update(whatsappMessageLog)
      .set({
        twilioSid: result.sid,
        status: "sent",
        statusUpdatedAt: now,
        ...(result.priceCents !== undefined && { priceCents: result.priceCents }),
      })
      .where(eq(whatsappMessageLog.id, row.id));

    return "sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(db, row.id, message.slice(0, 20), now);
    return "failed";
  }
}

async function markFailed(
  db: Database,
  id: string,
  errorCode: string,
  now: Date,
): Promise<void> {
  /*
   * Terminal. The row is not returned to `queued` for another attempt.
   *
   * A rejected send and a send whose *response* was lost are indistinguishable
   * from here, and retrying the second one double-charges the pharmacy's
   * conversation budget and double-messages a human. §4.4 asks for the message
   * not to be dropped silently; it does not ask for it to be sent twice. The
   * failure is recorded with its error code and is visible to an operator,
   * which is the honest resolution when the transport gives us nothing to be
   * idempotent against.
   */
  await db
    .update(whatsappMessageLog)
    .set({ status: "failed", errorCode, statusUpdatedAt: now })
    .where(eq(whatsappMessageLog.id, id));
}

export interface StalledSend {
  readonly id: string;
  readonly claimedAt: Date | null;
  readonly claimedBy: string | null;
}

/**
 * Rows claimed by a worker that then died before recording an outcome.
 *
 * **Nothing reclaims these automatically, and that is the design.** A worker
 * killed between `sender.sendTemplate()` returning and the `UPDATE` landing
 * has already sent the message; a worker killed just before the Twilio call
 * has not. The row looks identical in both cases, and Twilio offers no
 * idempotency key that would let us tell them apart or make a re-send safe.
 *
 * Auto-reclaiming would resolve that ambiguity in favour of double-sending a
 * billable message to a human. Surfacing it resolves it in favour of an
 * operator looking at the Twilio console for thirty seconds. The second is the
 * right default; a stuck row is a smaller problem than a duplicate message,
 * and unlike a duplicate it is still fixable.
 */
export async function findStalledSends(
  db: Database,
  now: Date = new Date(),
  thresholdMs = STALL_THRESHOLD_MS,
): Promise<StalledSend[]> {
  const cutoff = new Date(now.getTime() - thresholdMs);

  return db
    .select({
      id: whatsappMessageLog.id,
      claimedAt: whatsappMessageLog.claimedAt,
      claimedBy: whatsappMessageLog.claimedBy,
    })
    .from(whatsappMessageLog)
    .where(
      and(
        eq(whatsappMessageLog.status, "queued"),
        isNotNull(whatsappMessageLog.scheduledFor),
        isNotNull(whatsappMessageLog.claimedAt),
        lt(whatsappMessageLog.claimedAt, cutoff),
      ),
    )
    .orderBy(asc(whatsappMessageLog.claimedAt));
}

/** Depth of the undrained backlog, for the §11.6 burst alert. */
export async function pendingBacklogSize(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappMessageLog)
    .where(
      and(
        eq(whatsappMessageLog.status, "queued"),
        isNotNull(whatsappMessageLog.scheduledFor),
        lte(whatsappMessageLog.scheduledFor, now),
        isNull(whatsappMessageLog.claimedAt),
      ),
    );

  return row?.count ?? 0;
}

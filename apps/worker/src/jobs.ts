import {
  drainDeferredMessages,
  findStalledSends,
  pendingBacklogSize,
  processDueCharges,
  remindUpcomingShifts,
  rolloverDuePeriods,
  sweepExpiredQuotas,
  sweepNearbyDigest,
  type DashboardNotifyDeps,
  type DrainDeps,
  type DunningDeps,
} from "@locum/core";
import type { Database } from "@locum/db";

/**
 * The job bodies, with no BullMQ in sight.
 *
 * BullMQ decides *when* these run and Redis remembers that they should; that
 * is all it is trusted with. In particular none of the correctness here
 * depends on the queue delivering a job exactly once — BullMQ, like every
 * other Redis-backed queue, is at-least-once, and building a "send this
 * WhatsApp message" guarantee on top of that would be building it on sand.
 * The exactly-once property lives in Postgres, in the `FOR UPDATE SKIP LOCKED`
 * claim in `@locum/core`. A duplicate job firing here is a wasted query, not a
 * duplicate message.
 *
 * Which means these functions are directly callable and directly testable:
 * `pnpm --filter @locum/worker exec tsx -e '...'` and an admin "flush now"
 * button both go through the same code the scheduler does.
 */

export const JOB_NAMES = {
  drainDeferredMessages: "messaging.drain-deferred",
  processDueCharges: "billing.process-due-charges",
  rolloverBillingPeriods: "billing.rollover-periods",
  reportStalledSends: "messaging.report-stalled",
  sweepQuotas: "ratelimit.sweep",
  remindUpcomingShifts: "messaging.remind-upcoming-shifts",
  sweepNearbyDigest: "messaging.sweep-nearby-digest",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export interface JobLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface JobContext {
  readonly db: Database;
  readonly log: JobLogger;
}

/** §4.4 — send everything whose quiet-hours deferral has come due. */
export async function runDrainDeferredMessages(
  ctx: JobContext,
  deps: DrainDeps,
  batchSize: number,
): Promise<void> {
  const backlog = await pendingBacklogSize(ctx.db);
  const result = await drainDeferredMessages(ctx.db, deps, batchSize);

  if (result.claimed === 0) return;

  /*
   * `backlog` is reported alongside the batch so the 07:00 burst is visible as
   * a burst. §11.6 names this specifically: a night's worth of deferred
   * messages draining at once is what pushes the daily conversation spend over
   * its cap, and a log line that only says "sent 50" hides the other 400
   * waiting behind them.
   */
  ctx.log.info(
    { ...result, backlogAtStart: backlog, remaining: backlog - result.claimed },
    "drained deferred messages",
  );

  if (result.failed > 0) {
    ctx.log.warn({ failed: result.failed }, "deferred sends failed and will not be retried");
  }
}

/** §2 — attempt every subscription charge whose retry is due. */
export async function runProcessDueCharges(
  ctx: JobContext,
  deps: DunningDeps,
  batchSize: number,
): Promise<void> {
  const results = await processDueCharges(ctx.db, deps, batchSize);
  if (results.length === 0) return;

  const tally = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.outcome] = (acc[result.outcome] ?? 0) + 1;
    return acc;
  }, {});

  ctx.log.info({ attempted: results.length, ...tally }, "processed due charges");

  /*
   * `unresolved` is the outcome worth paging on, and the reason it is called
   * out separately rather than folded into a failure count. A decline is a
   * normal business event — a card expired. `unresolved` means we asked the
   * provider to move money and never learned whether it did, and the charge
   * stays that way until a reconciliation lookup succeeds. A run where those
   * accumulate is a provider incident, not a batch of bad cards.
   */
  if ((tally["unresolved"] ?? 0) > 0) {
    ctx.log.warn(
      { unresolved: tally["unresolved"] },
      "charges with no definite answer from the provider — awaiting reconciliation",
    );
  }
}

/**
 * §2 — open month 2+'s charge for every active subscription whose period has
 * ended, and advance the period.
 *
 * This is the piece that was missing entirely: without it, `activateSubscription`
 * bills a pharmacy exactly once, at Subscribe, and never again — the period
 * end sails past `now` with no error and no charge. The opened charge lands
 * in `subscription_charges` as `pending`; `runProcessDueCharges` above is
 * what actually attempts it, on its own schedule, same as any other charge.
 */
export async function runRolloverBillingPeriods(
  ctx: JobContext,
  batchSize: number,
): Promise<void> {
  const results = await rolloverDuePeriods(ctx.db, { limit: batchSize });
  if (results.length === 0) return;

  ctx.log.info(
    { rolledOver: results.length, totalCents: results.reduce((sum, r) => sum + r.amountCents, 0) },
    "opened next-period charges",
  );
}

/**
 * §4.4 — surface claims abandoned by a worker that died mid-send.
 *
 * Reports; does not reclaim. The reasoning is in `findStalledSends`: the row
 * cannot distinguish "died before the Twilio call" from "died after it", and
 * resolving that ambiguity automatically resolves it in favour of sending a
 * billable message to a human twice.
 */
export async function runReportStalledSends(ctx: JobContext): Promise<void> {
  const stalled = await findStalledSends(ctx.db);
  if (stalled.length === 0) return;

  ctx.log.warn(
    {
      count: stalled.length,
      workers: [...new Set(stalled.map((row) => row.claimedBy))],
      oldestClaimedAt: stalled[0]?.claimedAt,
    },
    "deferred sends claimed but never completed — needs a human to check Twilio before re-sending",
  );
}

/**
 * §12.1 — drops rate-limit counters for windows that have closed.
 *
 * One row per active user per action per window, forever, unless something
 * removes them. A rate limiter that grows into the largest table in the
 * database is a self-inflicted outage, and an unusually annoying one because
 * the mechanism protecting the service is the thing taking it down.
 */
export async function runSweepQuotas(ctx: JobContext): Promise<void> {
  const removed = await sweepExpiredQuotas(ctx.db);
  if (removed > 0) {
    ctx.log.info({ removed }, "swept expired rate-limit counters");
  }
}

/**
 * shift_starting_soon — reminds every confirmed booking whose shift just
 * entered the lead window, once each. §4.4 quiet hours never apply to this
 * one; see the template's own note.
 */
export async function runRemindUpcomingShifts(
  ctx: JobContext,
  deps: DashboardNotifyDeps,
  batchSize: number,
  leadMinutes: number,
): Promise<void> {
  const results = await remindUpcomingShifts(ctx.db, deps, { limit: batchSize, leadMinutes });
  if (results.length === 0) return;

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome.status] = (acc[r.outcome.status] ?? 0) + 1;
    return acc;
  }, {});

  ctx.log.info({ reminded: results.length, ...tally }, "sent shift-starting-soon reminders");
}

/**
 * "N locums near you" / "N pharmacies hiring near you" — the idle-digest
 * fallback for whoever the real-time reciprocal path (in apps/api, on
 * setAvailability and shift creation) isn't telling anything right now.
 */
export async function runSweepNearbyDigest(
  ctx: JobContext,
  deps: DashboardNotifyDeps,
  batchSize: number,
): Promise<void> {
  const { sent } = await sweepNearbyDigest(ctx.db, deps, { limit: batchSize });
  if (sent > 0) {
    ctx.log.info({ sent }, "sent nearby-activity digest nudges");
  }
}

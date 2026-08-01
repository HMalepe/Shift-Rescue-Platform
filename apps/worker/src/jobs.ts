import {
  drainDeferredMessages,
  findStalledSends,
  pendingBacklogSize,
  processDueCharges,
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
  reportStalledSends: "messaging.report-stalled",
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

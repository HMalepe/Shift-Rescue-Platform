import { Queue, QueueEvents, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { DrainDeps, DunningDeps } from "@locum/core";
import { classify, type ErrorReporter } from "@locum/observability";
import type { Database } from "@locum/db";
import type { WorkerConfig } from "./config";
import {
  JOB_NAMES,
  runDrainDeferredMessages,
  runProcessDueCharges,
  runReportStalledSends,
  runSweepQuotas,
  type JobContext,
  type JobLogger,
} from "./jobs";

export const QUEUE_NAME = "locum-scheduled";

export interface SchedulerDeps {
  readonly db: Database;
  readonly log: JobLogger & { error(context: Record<string, unknown>, message: string): void };
  readonly drain: DrainDeps;
  readonly dunning: DunningDeps;
  readonly reporter: ErrorReporter;
}

export interface RunningScheduler {
  readonly queue: Queue;
  readonly worker: Worker;
  /**
   * Exposed so a caller can await a specific job's completion.
   *
   * Nothing in production does — the schedules are fire-and-forget. It exists
   * for tests, which need to assert on the *effect* of a firing rather than on
   * the fact that one was enqueued, and that requires knowing when it finished.
   */
  readonly queueEvents: QueueEvents;
  close(): Promise<void>;
}

/**
 * Wires the jobs to BullMQ repeatable schedules.
 *
 * ## Why a queue at all, when nothing enqueues work
 *
 * Every job here is a periodic sweep of a Postgres table; none of them is
 * triggered by a user action. A bare `setInterval` in one process would run
 * them. What Redis buys is that the *schedule* survives a deploy and does not
 * multiply with the number of replicas: BullMQ's repeatable jobs are stored in
 * Redis, so N worker replicas produce one firing per interval rather than N.
 * Scaling the worker for availability must not scale how often the dunning
 * ladder advances.
 *
 * It is worth being clear about what this does *not* buy. BullMQ is
 * at-least-once; a job can fire twice across a failover. Nothing here depends
 * on it not doing so — see the note in jobs.ts.
 */
export function startScheduler(
  config: WorkerConfig,
  deps: SchedulerDeps,
): RunningScheduler {
  const connection: ConnectionOptions = {
    url: config.REDIS_URL,
    /*
     * BullMQ requires this: with retries enabled, a command issued while Redis
     * is unreachable is buffered and replayed on reconnect, which for a
     * blocking queue read means the worker silently stops consuming.
     */
    maxRetriesPerRequest: null,
  };

  const queue = new Queue(QUEUE_NAME, { connection });
  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  const ctx: JobContext = { db: deps.db, log: deps.log };

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case JOB_NAMES.drainDeferredMessages:
          return runDrainDeferredMessages(ctx, deps.drain, config.DRAIN_BATCH_SIZE);
        case JOB_NAMES.processDueCharges:
          return runProcessDueCharges(ctx, deps.dunning, config.DUNNING_BATCH_SIZE);
        case JOB_NAMES.reportStalledSends:
          return runReportStalledSends(ctx);
        case JOB_NAMES.sweepQuotas:
          return runSweepQuotas(ctx);
        default:
          /*
           * Thrown, not logged and swallowed. An unknown job name means a
           * repeatable schedule outlived the code that handled it — a rename
           * that shipped without clearing the old Redis schedule. Failing
           * loudly is how that gets noticed; silently ignoring it is how a
           * renamed job stops running for a month.
           */
          throw new Error(`no handler for job "${job.name}"`);
      }
    },
    {
      connection,
      /*
       * One job at a time. These are sweeps over shared tables and there is no
       * user waiting; running them concurrently would only add lock contention
       * between a worker and itself.
       */
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    deps.log.error({ job: job?.name, error: error.message }, "scheduled job failed");

    /*
     * §0.1 — a failing scheduled job is the archetypal silent failure. Nobody
     * is waiting on a response, nothing turns red, and the 07:00 backlog
     * simply does not go out. There is no user to notice on our behalf, which
     * is exactly why this one alerts even though a failed HTTP request from
     * the same cause might not.
     */
    deps.reporter.report({
      error,
      operation: `job.${job?.name ?? "unknown"}`,
      severity: classify(error),
      context: { attempts: job?.attemptsMade ?? 0 },
    });
  });

  return {
    queue,
    worker,
    queueEvents,
    async close() {
      await worker.close();
      // Deliver anything reported on the way down. The interesting failures
      // cluster just before a process exits.
      await deps.reporter.flush(3_000);
      await queueEvents.close();
      await queue.close();
    },
  };
}

/** The schedules this build of the worker wants to exist, and nothing else. */
export function desiredSchedules(
  config: WorkerConfig,
): ReadonlyArray<{ name: string; every: number }> {
  return [
    { name: JOB_NAMES.drainDeferredMessages, every: config.DRAIN_INTERVAL_MS },
    { name: JOB_NAMES.processDueCharges, every: config.DUNNING_INTERVAL_MS },
    // Stall triage is diagnostic, not operational; a fifth of the drain
    // cadence is plenty and keeps it out of the drain's way.
    { name: JOB_NAMES.reportStalledSends, every: config.DRAIN_INTERVAL_MS * 5 },
    // Housekeeping. Hourly is far more often than needed for a 48h retention,
    // and it is one indexed DELETE.
    { name: JOB_NAMES.sweepQuotas, every: 3_600_000 },
  ];
}

/**
 * Reconciles Redis to `desiredSchedules` — adds what is missing, removes what
 * is not wanted.
 *
 * The removal half is the part that earns its keep. A job scheduler is keyed
 * by name, and `upsertJobScheduler` updates an existing one in place, so a
 * changed interval converges cleanly. A *renamed* or deleted job does not: its
 * scheduler stays in Redis and keeps firing forever, and the handler in
 * `startScheduler` will throw `no handler for job "..."` every interval, which
 * is exactly the loud failure that switch statement was written to produce.
 * Reconciling here means that alarm fires once after a deploy and then stops,
 * rather than needing someone to go and clear Redis by hand.
 */
export async function registerSchedules(
  queue: Queue,
  config: WorkerConfig,
): Promise<void> {
  const wanted = desiredSchedules(config);
  const wantedNames = new Set(wanted.map((s) => s.name));

  for (const existing of await queue.getJobSchedulers()) {
    if (!existing.name || !wantedNames.has(existing.name)) {
      await queue.removeJobScheduler(existing.key);
    }
  }

  for (const { name, every } of wanted) {
    await queue.upsertJobScheduler(
      name,
      { every },
      {
        name,
        opts: {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      },
    );
  }
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "@locum/db";
import * as s from "@locum/db/schema";
import { FakePaymentProvider, FakeWhatsAppSender, sendWhatsAppMessage } from "@locum/core";
import { loadWorkerConfig, type WorkerConfig } from "../src/config";
import {
  JOB_NAMES,
  runDrainDeferredMessages,
  runReportStalledSends,
  type JobContext,
} from "../src/jobs";
import { QUEUE_NAME, desiredSchedules, registerSchedules, startScheduler } from "../src/scheduler";

/**
 * GATE: worker.scheduled_jobs
 *
 * Two separate things are under test and they fail in different ways.
 *
 * The *jobs* are pure functions over a real Postgres, and their correctness is
 * already carried by the gate tests in @locum/core. What is tested here is the
 * seam: that the scheduler reaches them at all, and that a firing actually
 * moves a row rather than logging that it did.
 *
 * The *scheduler* is Redis state that survives deploys, which is the part
 * nobody tests and everybody eventually debugs at 2am — a repeatable job left
 * over from a rename, firing forever against a handler that no longer exists.
 */

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const { db, client } = createDatabase({
  url:
    process.env["DATABASE_URL"] ??
    "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
  maxConnections: 5,
});

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...loadWorkerConfig({
      DATABASE_URL: "postgresql://unused",
      REDIS_URL,
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

const createdUserIds: string[] = [];

function collectingLogger() {
  const lines: Array<{ level: string; context: Record<string, unknown>; message: string }> = [];
  return {
    lines,
    info: (context: Record<string, unknown>, message: string) =>
      lines.push({ level: "info", context, message }),
    warn: (context: Record<string, unknown>, message: string) =>
      lines.push({ level: "warn", context, message }),
    error: (context: Record<string, unknown>, message: string) =>
      lines.push({ level: "error", context, message }),
  };
}

async function makeUserWithDeferredMessage(): Promise<string> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [user] = await db
    .insert(s.users)
    .values({
      role: "locum",
      email: `worker-${tag}@test.invalid`,
      fullName: "Worker Tester",
      phone: `+2782${Math.floor(Math.random() * 9_000_000) + 1_000_000}`,
      whatsappOptInAt: new Date(Date.now() - 86_400_000),
    })
    .returning({ id: s.users.id });
  createdUserIds.push(user!.id);

  // 02:00 SAST — inside the default quiet window, so this defers.
  const quietHour = new Date();
  quietHour.setUTCHours(0, 0, 0, 0);

  const outcome = await sendWhatsAppMessage(
    db,
    { sender: new FakeWhatsAppSender(), now: () => quietHour },
    { type: "booking_confirmed", userId: user!.id, variables: ["Sandton", "08:00"] },
  );
  if (outcome.status !== "deferred") throw new Error(`expected deferral, got ${outcome.status}`);

  return user!.id;
}

beforeAll(async () => {
  // Fail fast and clearly if Redis is not up, rather than hanging on the first
  // blocking read with a timeout that says nothing.
  const probe = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  await probe.waitUntilReady();
  await probe.obliterate({ force: true });
  await probe.close();
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db
      .delete(s.whatsappMessageLog)
      .where(inArray(s.whatsappMessageLog.userId, createdUserIds));
    await db.delete(s.users).where(inArray(s.users.id, createdUserIds));
  }
  const cleanup = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  await cleanup.obliterate({ force: true });
  await cleanup.close();
  await client.end();
});

describe("GATE worker.scheduled_jobs — §4.4 / §2", () => {
  it("a scheduled firing actually sends the deferred message", async () => {
    /*
     * The seam test. Everything either side of it is covered elsewhere; what
     * this proves is that a job dispatched through BullMQ lands in the handler
     * and that the handler moves a real row. A worker that logs "drained 1"
     * and changes nothing is the failure being ruled out.
     */
    const userId = await makeUserWithDeferredMessage();
    const log = collectingLogger();
    const sender = new FakeWhatsAppSender();

    const scheduler = startScheduler(
      { ...config(), REDIS_URL },
      {
        db,
        log,
        // The drain's `now` is pushed past 07:00 so the row is due.
        drain: { sender, workerId: "test-worker", now: () => new Date(Date.now() + 86_400_000) },
        dunning: { provider: new FakePaymentProvider() },
      },
    );
    const queue = scheduler.queue;

    try {
      const job = await queue.add(JOB_NAMES.drainDeferredMessages, {});
      await job.waitUntilFinished(scheduler.queueEvents);

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]!.templateName).toBe("booking_confirmed_v1");

      const [row] = await db
        .select({ status: s.whatsappMessageLog.status })
        .from(s.whatsappMessageLog)
        .where(eq(s.whatsappMessageLog.userId, userId));
      expect(row!.status).toBe("sent");
    } finally {
      await scheduler.close();
    }
  });

  it("throws on a job name it has no handler for", async () => {
    /*
     * A repeatable schedule outlives the code that created it. Rename a job
     * and the old scheduler keeps firing from Redis forever. The switch throws
     * so that shows up as a failed job; swallowing it is how a renamed job
     * quietly stops running for a month.
     */
    const log = collectingLogger();
    const scheduler = startScheduler(
      { ...config(), REDIS_URL },
      {
        db,
        log,
        drain: { sender: new FakeWhatsAppSender(), workerId: "test-worker" },
        dunning: { provider: new FakePaymentProvider() },
      },
    );

    try {
      const job = await scheduler.queue.add("messaging.drain-deferrred", {}, { attempts: 1 });
      await expect(job.waitUntilFinished(scheduler.queueEvents)).rejects.toThrow(
        /no handler for job/,
      );
    } finally {
      await scheduler.close();
    }
  });

  it("removes a schedule that is no longer wanted instead of leaving it firing", async () => {
    /*
     * The 2am bug this exists to prevent: a job renamed in code, its old
     * scheduler still in Redis, firing on a cadence that appears nowhere in
     * the configuration.
     */
    const cfg = { ...config(), REDIS_URL };
    const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });

    try {
      await queue.obliterate({ force: true });
      await queue.upsertJobScheduler("messaging.drain-deferred-OLD-NAME", { every: 60_000 });
      expect(await queue.getJobSchedulers()).toHaveLength(1);

      await registerSchedules(queue, cfg);

      const names = (await queue.getJobSchedulers()).map((sched) => sched.name).sort();
      expect(names).toEqual([...desiredSchedules(cfg)].map((sched) => sched.name).sort());
      expect(names).not.toContain("messaging.drain-deferred-OLD-NAME");
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("registering twice does not double the schedules", async () => {
    // Every deploy calls this. Accumulating a duplicate per deploy would
    // double the dunning cadence weekly, which is the kind of drift that only
    // becomes visible once a pharmacy is charged twice as often as intended.
    const cfg = { ...config(), REDIS_URL };
    const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });

    try {
      await queue.obliterate({ force: true });
      await registerSchedules(queue, cfg);
      await registerSchedules(queue, cfg);

      expect(await queue.getJobSchedulers()).toHaveLength(desiredSchedules(cfg).length);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("reports a stalled claim rather than re-sending it", async () => {
    const userId = await makeUserWithDeferredMessage();

    // A worker claimed the row and died before recording an outcome.
    const [row] = await db
      .select({ id: s.whatsappMessageLog.id })
      .from(s.whatsappMessageLog)
      .where(eq(s.whatsappMessageLog.userId, userId));
    await db
      .update(s.whatsappMessageLog)
      .set({ claimedAt: new Date(Date.now() - 3_600_000), claimedBy: "worker-that-died" })
      .where(eq(s.whatsappMessageLog.id, row!.id));

    const log = collectingLogger();
    const ctx: JobContext = { db, log };
    await runReportStalledSends(ctx);

    const warning = log.lines.find((line) => line.message.includes("claimed but never completed"));
    expect(warning, "a stalled claim must be surfaced, not silently left").toBeDefined();
    expect(warning!.context["workers"]).toContain("worker-that-died");
  });

  it("logs nothing when there is no work", async () => {
    /*
     * The drain runs every minute, all day, and finds nothing almost every
     * time. A job that logs on every empty run buries the 07:00 burst — the
     * one line anyone actually wants — under 1,400 lines of noise a day.
     */
    const log = collectingLogger();
    await runDrainDeferredMessages(
      { db, log },
      { sender: new FakeWhatsAppSender(), workerId: "test-worker", now: () => new Date(0) },
      50,
    );
    expect(log.lines).toHaveLength(0);
  });
});

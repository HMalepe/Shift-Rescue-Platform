import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  FakeWhatsAppSender,
  claimDueMessages,
  drainDeferredMessages,
  findStalledSends,
  pendingBacklogSize,
  sendWhatsAppMessage,
  type DrainDeps,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: messaging.quiet_hours_drain
 *
 * §4.4 defers a message rather than dropping it, which is only half a
 * guarantee — the other half is that something comes back at 07:00 and sends
 * it exactly once.
 *
 * "Exactly once" is the whole gate. Twilio's message API has no idempotency
 * key, so a duplicate is charged twice and read twice by a human, and there is
 * no way to take it back. Two workers polling the same due-set is the normal
 * steady state of any real deployment, so the race below is not a pathological
 * case — it is Tuesday.
 */

const { db, client } = connect();
const createdUserIds: string[] = [];

async function makeUser(
  options: { optedIn?: boolean; optedOutAt?: Date | null } = {},
): Promise<string> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [user] = await db
    .insert(s.users)
    .values({
      role: "locum",
      email: `drain-${tag}@test.invalid`,
      fullName: "Drain Tester",
      phone: `+2782${Math.floor(Math.random() * 9_000_000) + 1_000_000}`,
      whatsappOptInAt:
        options.optedIn === false ? null : new Date(Date.now() - 86_400_000),
      ...(options.optedOutAt ? { whatsappOptOutAt: options.optedOutAt } : {}),
    })
    .returning({ id: s.users.id });
  createdUserIds.push(user!.id);
  return user!.id;
}

function makeDeps(
  overrides: Partial<DrainDeps> = {},
): DrainDeps & { sender: FakeWhatsAppSender } {
  const sender = (overrides.sender as FakeWhatsAppSender) ?? new FakeWhatsAppSender();
  return {
    workerId: `worker-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
    sender,
  } as DrainDeps & { sender: FakeWhatsAppSender };
}

/** 02:00 SAST — inside the default 21:00–07:00 quiet window. */
function smallHours(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Defers a real message through the production path rather than hand-writing
 * the queued row. If `sendWhatsAppMessage` ever stops persisting something the
 * drain needs, this catches it; a hand-built fixture would paper over it.
 */
async function deferOne(
  userId: string,
  variables: readonly string[] = ["Sandton Pharmacy", "Tuesday 08:00"],
): Promise<Date> {
  const outcome = await sendWhatsAppMessage(
    db,
    makeDeps({ now: smallHours }),
    { type: "booking_confirmed", userId, variables },
  );
  if (outcome.status !== "deferred") {
    throw new Error(`expected deferral, got ${outcome.status}`);
  }
  return outcome.scheduledFor;
}

/** After 07:00, so the deferred rows are due. */
function afterDue(scheduledFor: Date): Date {
  return new Date(scheduledFor.getTime() + 60_000);
}

afterEach(async () => {
  const ids = createdUserIds.splice(0);
  if (ids.length === 0) return;
  await db.delete(s.whatsappMessageLog).where(inArray(s.whatsappMessageLog.userId, ids));
  await db.delete(s.users).where(inArray(s.users.id, ids));
});

afterAll(async () => {
  await client.end();
});

describe("GATE messaging.quiet_hours_drain — §4.4", () => {
  it("sends the deferred message with the variables composed at deferral time", async () => {
    const userId = await makeUser();
    const due = await deferOne(userId, ["Rosebank Pharmacy", "Friday 09:00"]);

    const deps = makeDeps({ now: () => afterDue(due) });
    const result = await drainDeferredMessages(db, deps);

    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(deps.sender.sent).toHaveLength(1);
    expect(deps.sender.sent[0]!.templateName).toBe("booking_confirmed_v1");
    /*
     * The reason the `variables` column exists. Before it, the queued row knew
     * which template to send but not what to put in it, and Meta rejects a
     * template rendered with the wrong arity — a silent failed send, which is
     * exactly what §11.3 warns about.
     */
    expect(deps.sender.sent[0]!.variables).toEqual([
      "Rosebank Pharmacy",
      "Friday 09:00",
    ]);
  });

  it("replaces the deferred placeholder SID with the real one", async () => {
    const userId = await makeUser();
    const due = await deferOne(userId);

    const deps = makeDeps({ now: () => afterDue(due) });
    await drainDeferredMessages(db, deps);

    const [row] = await db
      .select({
        sid: s.whatsappMessageLog.twilioSid,
        status: s.whatsappMessageLog.status,
        price: s.whatsappMessageLog.priceCents,
      })
      .from(s.whatsappMessageLog)
      .where(eq(s.whatsappMessageLog.userId, userId));

    // §11.5's dedupe key: the delivery-status webhook arriving seconds later
    // must find THIS row, not create an orphan.
    expect(row!.sid.startsWith("deferred:")).toBe(false);
    expect(row!.sid).toMatch(/^SMfake/);
    expect(row!.status).toBe("sent");
    // §11.6 — the burst is only billable if the cost is recorded.
    expect(row!.price).toBe(8);
  });

  it("does not send a message twice when two workers drain the same backlog", async () => {
    /*
     * The end-to-end statement of the guarantee: run two workers, get twelve
     * messages, not thirteen.
     *
     * Worth being precise about what this does and does not prove. It is an
     * observation of the happy path, and it survives with `skip locked`
     * removed — with a small batch the two claim statements rarely overlap in
     * the window that matters, so the second worker's subquery sees the first
     * worker's committed claims and finds nothing. The test below is the one
     * that actually catches that mutation.
     */
    const userIds = await Promise.all(
      Array.from({ length: 12 }, () => makeUser()),
    );
    let due: Date | undefined;
    for (const id of userIds) due = await deferOne(id);

    const now = () => afterDue(due!);
    const workerA = makeDeps({ now, workerId: "worker-a" });
    const workerB = makeDeps({ now, workerId: "worker-b" });

    const [a, b] = await Promise.all([
      drainDeferredMessages(db, workerA),
      drainDeferredMessages(db, workerB),
    ]);

    // Every message went out, and not one went out twice.
    expect(a.sent + b.sent).toBe(12);
    expect(workerA.sender.sent.length + workerB.sender.sent.length).toBe(12);

    const rows = await db
      .select({ sid: s.whatsappMessageLog.twilioSid })
      .from(s.whatsappMessageLog)
      .where(inArray(s.whatsappMessageLog.userId, userIds));
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.sid)).size).toBe(12);
  });

  it("claims no more than the batch size", async () => {
    /*
     * Regression test for a bug that was invisible from the outside.
     *
     * The claim was originally `update ... where id in (select ... limit N)`.
     * Postgres flattens that into a semi-join and rescans the subquery per
     * outer row, so every rescan claimed another N rows and the limit bound
     * nothing — `limit 3` against six due rows claimed all six. Every message
     * still went out exactly once, so no behavioural test caught it; only
     * EXPLAIN did.
     *
     * It matters because the batch size is what paces the 07:00 backlog
     * against Twilio's rate limits. A limit that does not limit means one
     * statement claims the whole night's queue and sends it serially.
     */
    const userIds = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    let due: Date | undefined;
    for (const id of userIds) due = await deferOne(id);

    const claimed = await claimDueMessages(db, "worker-a", afterDue(due!), 3);
    expect(claimed).toHaveLength(3);
  });

  it("steps over rows another worker holds instead of blocking behind them", async () => {
    /*
     * THE gate, and the mutation check for it.
     *
     * Worker A claims three rows inside a transaction it does not commit —
     * i.e. a worker that has claimed work and is mid-send, which is where a
     * worker spends most of its time. Worker B then claims. With SKIP LOCKED,
     * B steps over A's three and returns the other three immediately. Without
     * it, B blocks on A's locks until A commits.
     *
     * The assertion is therefore bounded on *time*, not just on contents. Take
     * `for update skip locked` out of `claimDueMessages` and B never returns
     * within the deadline, and this fails with a named reason rather than
     * hanging the suite until the runner's timeout — a test that catches a
     * regression by never finishing tells you almost nothing about what broke.
     */
    const userIds = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    let due: Date | undefined;
    for (const id of userIds) due = await deferOne(id);
    const now = afterDue(due!);

    const BLOCKED = Symbol("blocked");
    const DEADLINE_MS = 2_000;

    const outcome = await db.transaction(async (txA) => {
      const a = await claimDueMessages(txA, "worker-a", now, 3);
      expect(a).toHaveLength(3);

      // txA is still open and holds those three rows.
      const b = await Promise.race([
        claimDueMessages(db, "worker-b", now, 10),
        new Promise<typeof BLOCKED>((resolve) =>
          setTimeout(() => resolve(BLOCKED), DEADLINE_MS),
        ),
      ]);
      return { a, b };
    });

    expect(
      outcome.b,
      `worker B was still waiting on worker A's locks after ${DEADLINE_MS}ms — ` +
        "the claim is serialising rather than skipping locked rows",
    ).not.toBe(BLOCKED);

    const b = outcome.b as Awaited<ReturnType<typeof claimDueMessages>>;
    expect(b).toHaveLength(3);
    const held = new Set(outcome.a.map((r) => r.id));
    for (const row of b) {
      expect(held.has(row.id), "worker B claimed a row worker A held").toBe(false);
    }
  });

  it("honours an opt-out that happened AFTER the message was deferred", async () => {
    /*
     * The window §11.4 actually has to survive: composed at 22:00, opted out
     * at 23:00, due at 07:00. Trusting the consent captured at composition
     * time sends to someone who said STOP — a Meta compliance breach and a
     * POPIA one, and entirely invisible from the call site.
     */
    const userId = await makeUser();
    const due = await deferOne(userId);

    await db
      .update(s.users)
      .set({ whatsappOptOutAt: new Date() })
      .where(eq(s.users.id, userId));

    const deps = makeDeps({ now: () => afterDue(due) });
    const result = await drainDeferredMessages(db, deps);

    expect(result).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(deps.sender.sent).toHaveLength(0);

    const [row] = await db
      .select({ code: s.whatsappMessageLog.errorCode })
      .from(s.whatsappMessageLog)
      .where(eq(s.whatsappMessageLog.userId, userId));
    expect(row!.code).toBe("consent_withdrawn");
  });

  it("leaves a message that is not yet due alone", async () => {
    const userId = await makeUser();
    const due = await deferOne(userId);

    const deps = makeDeps({ now: () => new Date(due.getTime() - 60_000) });
    const result = await drainDeferredMessages(db, deps);

    expect(result.claimed).toBe(0);
    expect(deps.sender.sent).toHaveLength(0);
  });

  it("does not retry a failed send, and records why", async () => {
    /*
     * A Twilio failure and a lost Twilio *response* are indistinguishable from
     * here. Retrying resolves that ambiguity in favour of double-messaging a
     * human. §4.4 asks that the message not be dropped silently; it does not
     * ask that it be sent twice.
     */
    const userId = await makeUser();
    const due = await deferOne(userId);

    const sender = new FakeWhatsAppSender();
    sender.failNextSend("twilio unavailable");
    const deps = makeDeps({ now: () => afterDue(due), sender });

    expect(await drainDeferredMessages(db, deps)).toMatchObject({ sent: 0, failed: 1 });

    // Second pass: the row must not come back around.
    const second = makeDeps({ now: () => afterDue(due) });
    expect(await drainDeferredMessages(db, second)).toMatchObject({ claimed: 0 });
    expect(second.sender.sent).toHaveLength(0);

    const [row] = await db
      .select({
        status: s.whatsappMessageLog.status,
        code: s.whatsappMessageLog.errorCode,
      })
      .from(s.whatsappMessageLog)
      .where(eq(s.whatsappMessageLog.userId, userId));
    expect(row!.status).toBe("failed");
    expect(row!.code).toBe("twilio unavailable");
  });

  it("surfaces a claim abandoned by a dead worker without re-sending it", async () => {
    const userId = await makeUser();
    const due = await deferOne(userId);
    const now = afterDue(due);

    // A worker claims the row and then dies before recording an outcome.
    const claimed = await claimDueMessages(db, "worker-that-died", now, 10);
    expect(claimed).toHaveLength(1);

    const later = new Date(now.getTime() + 10 * 60_000);

    // Nothing reclaims it: the row may or may not already have been sent, and
    // guessing costs a duplicate billable message to a real person.
    const deps = makeDeps({ now: () => later });
    expect(await drainDeferredMessages(db, deps)).toMatchObject({ claimed: 0 });
    expect(deps.sender.sent).toHaveLength(0);

    // It is not lost either — an operator can see it.
    const stalled = await findStalledSends(db, later);
    const mine = stalled.filter((row) => row.id === claimed[0]!.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.claimedBy).toBe("worker-that-died");
  });

  it("reports backlog depth before the drain and zero after", async () => {
    const userIds = await Promise.all(Array.from({ length: 4 }, () => makeUser()));
    let due: Date | undefined;
    for (const id of userIds) due = await deferOne(id);
    const now = afterDue(due!);

    expect(await pendingBacklogSize(db, now)).toBeGreaterThanOrEqual(4);
    await drainDeferredMessages(db, makeDeps({ now: () => now }));

    const remaining = await db
      .select({ id: s.whatsappMessageLog.id })
      .from(s.whatsappMessageLog)
      .where(
        and(
          inArray(s.whatsappMessageLog.userId, userIds),
          eq(s.whatsappMessageLog.status, "queued"),
        ),
      );
    expect(remaining).toHaveLength(0);
  });
});

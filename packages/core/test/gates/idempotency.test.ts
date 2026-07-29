import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys } from "@locum/db";
import {
  hashPayload,
  sweepExpiredIdempotencyKeys,
  withIdempotency,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: code.idempotency
 *
 * §11.5 — "Twilio retries webhook delivery on timeout or non-2xx. Delivery
 * status webhooks and inbound message webhooks must be deduplicated on
 * Twilio's MessageSid/SmsSid before being processed."
 *
 * §15 classes this as G -> X: trivially generatable, but only closed by
 * running it. The concurrent case in particular cannot be verified by reading
 * code — a check-then-act implementation passes every sequential test and
 * fails only under real contention.
 */

const { db, client } = connect();

const scope = "twilio.status" as const;
const keysUsed: string[] = [];

function freshKey(): string {
  const key = `SM${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  keysUsed.push(key);
  return key;
}

afterEach(async () => {
  for (const key of keysUsed.splice(0)) {
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
  }
});

afterAll(async () => {
  await client.end();
});

describe("GATE code.idempotency", () => {
  it("runs the handler once and replays it thereafter", async () => {
    const key = freshKey();
    const payload = { MessageSid: key, MessageStatus: "delivered" };
    let runs = 0;

    const first = await withIdempotency(db, { scope, key, payload }, async () => {
      runs += 1;
      return { processed: true, at: "first" };
    });

    const second = await withIdempotency(db, { scope, key, payload }, async () => {
      runs += 1;
      return { processed: true, at: "second" };
    });

    expect(first.status).toBe("executed");
    expect(second.status).toBe("replayed");

    // The critical assertion: the second handler never ran.
    expect(runs).toBe(1);

    // And the replayed value is the FIRST result, not the second handler's.
    expect(second).toMatchObject({ result: { at: "first" } });
  });

  it("deduplicates a burst of identical Twilio retries", async () => {
    const key = freshKey();
    const payload = { MessageSid: key, MessageStatus: "delivered" };
    let runs = 0;

    // Twilio retrying while the first attempt is still in flight is the real
    // shape of this problem, and the case a SELECT-then-INSERT gets wrong.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        withIdempotency(db, { scope, key, payload }, async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { processed: true };
        }),
      ),
    );

    // Exactly one caller ever executes, no matter how they interleave.
    expect(runs).toBe(1);

    const executed = outcomes.filter((o) => o.status === "executed");
    expect(executed).toHaveLength(1);

    // The rest either replayed or were told to come back — never a second run.
    for (const outcome of outcomes) {
      expect(["executed", "replayed", "in_flight"]).toContain(outcome.status);
    }
  });

  it("rejects a reused key carrying a different body", async () => {
    const key = freshKey();

    await withIdempotency(
      db,
      { scope, key, payload: { MessageSid: key, MessageStatus: "delivered" } },
      async () => ({ ok: true }),
    );

    // Same key, different content. Replaying the cached response here would
    // silently swallow the new request.
    await expect(
      withIdempotency(
        db,
        { scope, key, payload: { MessageSid: key, MessageStatus: "failed" } },
        async () => ({ ok: true }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("hashes payloads independently of key order", () => {
    // A retry whose JSON serialises with different key order is still the same
    // request; treating it as different would wrongly trip the reuse guard.
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
    expect(hashPayload({ nested: { x: 1, y: 2 } })).toBe(
      hashPayload({ nested: { y: 2, x: 1 } }),
    );
  });

  it("releases the key when the handler throws, so a retry can succeed", async () => {
    const key = freshKey();
    const payload = { MessageSid: key };
    let attempts = 0;

    await expect(
      withIdempotency(db, { scope, key, payload }, async () => {
        attempts += 1;
        throw new Error("downstream unavailable");
      }),
    ).rejects.toThrow(/downstream unavailable/);

    // Twilio retries. Without the release-on-failure path this would report
    // in_flight until the TTL expired, permanently dropping the event.
    const retry = await withIdempotency(db, { scope, key, payload }, async () => {
      attempts += 1;
      return { recovered: true };
    });

    expect(retry.status).toBe("executed");
    expect(attempts).toBe(2);
  });

  it("reclaims an expired key instead of replaying a stale result", async () => {
    const key = freshKey();
    const payload = { MessageSid: key };

    await withIdempotency(db, { scope, key, payload, ttlSeconds: 1 }, async () => ({
      generation: 1,
    }));

    // Force expiry rather than sleeping, so the test stays fast and does not
    // depend on wall-clock timing.
    await db
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));

    const afterExpiry = await withIdempotency(
      db,
      { scope, key, payload },
      async () => ({ generation: 2 }),
    );

    expect(afterExpiry.status).toBe("executed");
    expect(afterExpiry).toMatchObject({ result: { generation: 2 } });
  });

  it("sweeps expired keys", async () => {
    const key = freshKey();
    await withIdempotency(db, { scope, key, payload: { a: 1 } }, async () => ({}));

    await db
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));

    const removed = await sweepExpiredIdempotencyKeys(db);
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    expect(remaining).toHaveLength(0);
  });
});

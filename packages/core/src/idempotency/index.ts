import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { idempotencyKeys, type Database } from "@locum/db";
import { DomainError } from "../errors";

/**
 * §11.5 — idempotency.
 *
 * Two callers, one mechanism:
 *
 *   - Twilio retries webhook delivery on timeout or any non-2xx. Delivery
 *     status and inbound message webhooks must be deduplicated on the Twilio
 *     SID before processing, or a single delivery receipt processed twice
 *     double-counts spend (§11.6) and can re-fire downstream side effects.
 *
 *   - Client-supplied keys on booking creation. A locum tapping "accept" twice
 *     on a patchy connection must not produce two requests.
 *
 * `scope` namespaces the two so a Twilio SID can never collide with a
 * client-generated UUID.
 */

export type IdempotencyScope =
  | "twilio.status"
  | "twilio.inbound"
  | "payfast.itn"
  | "booking.create"
  | "booking.confirm";

export interface IdempotencyRequest {
  readonly scope: IdempotencyScope;
  readonly key: string;
  /**
   * The request payload. Hashed, never stored — webhook bodies contain phone
   * numbers, and POPIA (§10) makes retaining them beyond need a liability.
   */
  readonly payload: unknown;
  /**
   * How long a completed result stays replayable. The default of 24h
   * comfortably outlives Twilio's retry schedule; past that the sweep job
   * reclaims the row.
   */
  readonly ttlSeconds?: number;
}

export type IdempotencyOutcome<T> =
  /** First caller to claim this key. The handler ran. */
  | { readonly status: "executed"; readonly result: T }
  /** A previous caller completed. Cached response replayed; handler did NOT run. */
  | { readonly status: "replayed"; readonly result: T }
  /**
   * Another caller holds the key and has not finished.
   *
   * Deliberately a distinct outcome rather than a thrown error or a silent
   * success. Answering 200 here would tell Twilio the event is handled while
   * the first attempt might still fail, losing it permanently. Answering
   * 409/503 makes Twilio retry, which is the safe direction.
   */
  | { readonly status: "in_flight" };

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export function hashPayload(payload: unknown): string {
  // Stable stringify: key order must not change the hash, or a retry that
  // serialises its JSON differently would look like a different request.
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Runs `handler` at most once per (scope, key).
 *
 * The claim is a single atomic statement rather than a SELECT-then-INSERT.
 * Under Twilio's retry behaviour two deliveries of the same SID routinely
 * arrive close enough together to interleave, and a check-then-act would let
 * both pass the check before either inserted.
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE expires_at < now()` does three jobs in
 * one round trip: claim a fresh key, reclaim an expired one, or yield to a
 * live holder. `xmax = 0` is the standard trick for telling an INSERT apart
 * from an UPDATE in the RETURNING clause.
 */
export async function withIdempotency<T>(
  db: Database,
  request: IdempotencyRequest,
  handler: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const requestHash = hashPayload(request.payload);
  const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const claim = await db.execute<{ inserted: boolean }>(sql`
    INSERT INTO idempotency_keys (scope, key, request_hash, expires_at)
    VALUES (
      ${request.scope},
      ${request.key},
      ${requestHash},
      now() + ${`${ttl} seconds`}::interval
    )
    ON CONFLICT (scope, key) DO UPDATE
      SET request_hash    = EXCLUDED.request_hash,
          expires_at      = EXCLUDED.expires_at,
          completed_at    = NULL,
          response_status = NULL,
          response_body   = NULL,
          created_at      = now()
      WHERE idempotency_keys.expires_at < now()
    RETURNING (xmax = 0) AS inserted
  `);

  const claimed = (claim as unknown as { inserted: boolean }[])[0];

  if (!claimed) {
    // Conflict, and the existing row is live. Inspect it.
    return inspectExisting<T>(db, request, requestHash);
  }

  // We own the key. Run the work, then record the outcome so a retry replays
  // rather than re-executing.
  let result: T;
  try {
    result = await handler();
  } catch (error) {
    /*
     * Release the key on failure.
     *
     * Leaving it claimed-but-incomplete would make every Twilio retry see
     * `in_flight` until the TTL expired — turning one transient failure into
     * 24 hours of a permanently unprocessable event. Deleting means the next
     * retry gets a clean attempt, which is the entire reason Twilio retries.
     */
    await db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, request.scope),
          eq(idempotencyKeys.key, request.key),
        ),
      );
    throw error;
  }

  await db
    .update(idempotencyKeys)
    .set({
      completedAt: new Date(),
      responseStatus: 200,
      responseBody: JSON.stringify(result ?? null),
    })
    .where(
      and(
        eq(idempotencyKeys.scope, request.scope),
        eq(idempotencyKeys.key, request.key),
      ),
    );

  return { status: "executed", result };
}

async function inspectExisting<T>(
  db: Database,
  request: IdempotencyRequest,
  requestHash: string,
): Promise<IdempotencyOutcome<T>> {
  const [existing] = await db
    .select({
      requestHash: idempotencyKeys.requestHash,
      completedAt: idempotencyKeys.completedAt,
      responseBody: idempotencyKeys.responseBody,
    })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.scope, request.scope),
        eq(idempotencyKeys.key, request.key),
      ),
    )
    .limit(1);

  if (!existing) {
    // The holder failed and released between our INSERT and this SELECT.
    return { status: "in_flight" };
  }

  /*
   * Same key, different body.
   *
   * This is never a retry — Twilio replays byte-identical payloads, and a
   * client reusing a key for new content is a bug on their side. Replaying the
   * cached response would silently discard the new request, so it is rejected
   * loudly instead.
   */
  if (existing.requestHash !== requestHash) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request body",
      { scope: request.scope, key: request.key },
    );
  }

  if (existing.completedAt === null) {
    return { status: "in_flight" };
  }

  return {
    status: "replayed",
    result: JSON.parse(existing.responseBody ?? "null") as T,
  };
}

/**
 * Deletes expired keys. Run on a schedule — Twilio does not retry forever, and
 * the table would otherwise grow without bound.
 */
export async function sweepExpiredIdempotencyKeys(
  db: Database,
): Promise<number> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(sql`${idempotencyKeys.expiresAt} < now()`)
    .returning({ id: idempotencyKeys.id });
  return deleted.length;
}

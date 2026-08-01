import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import {
  gateClock,
  gateStatus,
  whatsappCategory,
  whatsappDirection,
  whatsappStatus,
} from "./enums";

const now = sql`now()`;

/**
 * §11.5 — Twilio retries webhook delivery on timeout or non-2xx. Delivery
 * status webhooks and inbound messages must be deduplicated before processing.
 *
 * Generalised beyond Twilio: the same table backs client-supplied idempotency
 * keys on booking creation, so a locum double-tapping "accept" on a flaky
 * train connection does not produce two requests.
 *
 * `scope` separates key namespaces (`twilio.status`, `booking.create`) so a
 * Twilio SID can never collide with a client-generated UUID.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: varchar("scope", { length: 60 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),

    /**
     * Hash of the request body. A replayed key with a *different* body is a
     * client bug, not a retry, and must be rejected rather than silently
     * returning the first response.
     */
    requestHash: varchar("request_hash", { length: 64 }).notNull(),

    /** Cached response, replayed verbatim on a genuine retry. */
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),

    /** Set when processing finishes; null means in-flight. */
    completedAt: timestamp("completed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
    /** Swept by a maintenance job; Twilio does not retry forever. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_scope_key").on(table.scope, table.key),
    index("idempotency_keys_expires_idx").on(table.expiresAt),
  ],
);

/**
 * §11.7 — verbatim from the spec, with types tightened to the enums above.
 *
 * The reason this table exists at all: a "sent" event in analytics with no
 * corresponding delivery/read confirmation is not evidence anything reached
 * anyone, and the WhatsApp-vs-push open-rate comparison the marketing plan
 * leans on is worthless without it.
 */
export const whatsappMessageLog = pgTable(
  "whatsapp_message_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    twilioSid: varchar("twilio_sid", { length: 64 }).notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /** e.g. 'booking_confirmed', 'subscription_reminder'. */
    templateType: varchar("template_type", { length: 50 }),
    category: whatsappCategory("category"),
    direction: whatsappDirection("direction").notNull(),
    status: whatsappStatus("status").notNull().default("queued"),

    /**
     * §11.3 — whether this send went out as an approved template or as a
     * free-form reply inside the 24-hour session window. Recorded because a
     * business-initiated message that somehow went out free-form is a silent
     * failed send, and this column is how it gets noticed.
     */
    wasFreeform: varchar("was_freeform", { length: 5 }),

    /** §11.6 — per-message billable cost, for the daily spend cap and alerting. */
    priceCents: integer("price_cents"),

    /**
     * The template's positional variable bindings.
     *
     * Only meaningful on a deferred row (§4.4). A queued message is sent hours
     * after the code that requested it returned, so unless the bindings are
     * persisted here the worker knows *which* template to send but not what to
     * put in it — and a WhatsApp template sent with the wrong number of
     * variables is rejected by Meta, which surfaces as a silent failed send
     * rather than an error at the original call site.
     *
     * Stored rather than recomputed deliberately: the shift may have been
     * cancelled or re-priced between the deferral and the send, and the
     * message that goes out must be the one that was composed, not a fresh
     * render of changed state.
     */
    variables: jsonb("variables").$type<string[]>(),

    /**
     * Claim marker for the quiet-hours drain (§4.4).
     *
     * Set when a worker takes ownership of a queued row. Two workers polling
     * the same due-set is the normal steady state under any real deployment,
     * and without a claim both would send — a duplicate WhatsApp message costs
     * money and reads as a bug to the recipient. The claim is taken under
     * `FOR UPDATE SKIP LOCKED`, so a second worker steps over claimed rows
     * instead of blocking behind them.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: varchar("claimed_by", { length: 64 }),

    /**
     * §4.4 — when a send was deferred out of quiet hours, the time it should
     * actually go out (07:00 local).
     *
     * Null means "send immediately". A row with this set and status 'queued'
     * is the worker's work list.
     */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),

    errorCode: varchar("error_code", { length: 20 }),
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // The dedupe key from §11.5.
    uniqueIndex("whatsapp_message_log_twilio_sid_key").on(table.twilioSid),
    index("whatsapp_message_log_user_idx").on(table.userId),
    // Backs the §11.6 daily spend dashboard.
    index("whatsapp_message_log_created_category_idx").on(
      table.createdAt,
      table.category,
    ),
    /*
     * The quiet-hours worker's hot query: what is due to go out now.
     *
     * The predicate deliberately stops at `status = 'queued'` and does NOT
     * also require `claimed_at is null`, even though the drain's hot path
     * filters on that. Two queries need this index — "what can I claim" and
     * "what has been claimed but never finished" (§stalled sends below) — and
     * a predicate narrowed to unclaimed rows would serve the first and leave
     * the second doing a sequential scan of every message ever sent. The index
     * still self-prunes, because a drained row leaves `queued` entirely.
     */
    index("whatsapp_message_log_due_idx")
      .on(table.scheduledFor)
      .where(sql`${table.status} = 'queued' AND ${table.scheduledFor} is not null`),
  ],
);

/**
 * §12.5 — gate status as data.
 *
 * "Gate status recorded only in a document drifts from reality within days."
 * A gate cannot move to `passed` without a non-null `evidence_url`, and that
 * rule is enforced by a CHECK constraint in the migration rather than by
 * convention — see 0000_init.sql.
 */
export const verificationRuns = pgTable(
  "verification_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. 'code.concurrency', 'security.auth_rate_limit'. */
    gateId: varchar("gate_id", { length: 64 }).notNull(),
    /** A = generation, B = execution, C = external (§15). */
    clock: gateClock("clock").notNull(),
    status: gateStatus("status").notNull().default("not_started"),

    /** CI run, EXPLAIN output, legal opinion PDF, Meta approval screenshot. */
    evidenceUrl: text("evidence_url"),
    /** Human or CI identity. */
    executedBy: varchar("executed_by", { length: 120 }),
    notes: text("notes"),

    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    index("verification_runs_gate_idx").on(table.gateId),
    index("verification_runs_status_idx").on(table.status),
  ],
);

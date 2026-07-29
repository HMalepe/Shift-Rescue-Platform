import { sql } from "drizzle-orm";
import {
  index,
  integer,
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

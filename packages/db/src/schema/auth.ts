import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

const now = sql`now()`;

/**
 * Refresh-token sessions (§12.1: "token expiry/refresh strategy, session
 * invalidation on password change").
 *
 * Refresh tokens are opaque and stored here rather than being self-contained
 * JWTs. A stateless refresh token cannot be revoked before it expires, which
 * directly contradicts the requirement that changing a password logs the user
 * out everywhere. Access tokens stay short-lived and signed; only the refresh
 * path touches this table, so the cost is one query per refresh rather than
 * one per request.
 *
 * The token itself is never stored — only its SHA-256. A dump of this table
 * therefore does not let an attacker mint sessions, which matters for a
 * database holding SAPC numbers and employment documents (§10, POPIA).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** SHA-256 of the opaque refresh token. */
    refreshTokenHash: varchar("refresh_token_hash", { length: 64 }).notNull(),

    /**
     * Groups every token descended from one login.
     *
     * Rotation issues a new token on each refresh and marks the old one used.
     * If a *used* token is ever presented again, either it was stolen or the
     * legitimate client is replaying — and there is no way to tell which. The
     * safe response is to revoke the entire family, forcing a fresh login.
     * Without a family id, a thief who refreshes once holds a valid token
     * indefinitely and the theft is undetectable.
     */
    familyId: uuid("family_id").notNull(),

    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .default(now),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** Set when this token is exchanged. A non-null value means "already used". */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: varchar("revoked_reason", { length: 60 }),

    /** Recorded for the §12.2 dashboard and for user-visible session lists. */
    userAgent: text("user_agent"),
    ipAddress: varchar("ip_address", { length: 45 }),
  },
  (table) => [
    uniqueIndex("sessions_refresh_token_hash_key").on(table.refreshTokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_family_idx").on(table.familyId),
    // Swept by a maintenance job.
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);

/**
 * §12.1 — rate limiting on login/signup to prevent credential stuffing.
 *
 * Persisted rather than held in Redis alone, deliberately. Redis is the fast
 * path, but a credential-stuffing run spread thinly across many IPs is only
 * visible after the fact, and an in-memory counter that resets on deploy
 * destroys exactly the history needed to see it. This table is the durable
 * record the on-call rotation (§12.2) can query.
 */
export const authAttempts = pgTable(
  "auth_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lowercased email. Not a user_id: most stuffing hits accounts that do not exist. */
    identifier: varchar("identifier", { length: 320 }).notNull(),
    ipAddress: varchar("ip_address", { length: 45 }),
    successful: varchar("successful", { length: 5 }).notNull(),
    /** e.g. 'bad_password', 'no_such_user', 'mfa_required', 'mfa_failed'. */
    outcome: varchar("outcome", { length: 40 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // The lockout check reads by identifier over a recent window.
    index("auth_attempts_identifier_created_idx").on(
      table.identifier,
      table.createdAt,
    ),
    index("auth_attempts_ip_created_idx").on(table.ipAddress, table.createdAt),
  ],
);

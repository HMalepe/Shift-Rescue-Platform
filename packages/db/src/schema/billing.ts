import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { bookings } from "./shifts";
import { pharmacies } from "./identity";
import { chargeStatus, paymentProvider, subscriptionStatus } from "./enums";

const now = sql`now()`;

/**
 * §10.0 — SCOPE BOUNDARY, restated here because it is the thing most likely to
 * be eroded by a well-meaning future change:
 *
 *   The platform never touches locum wages. Not held, not routed, not
 *   escrowed, not disbursed, no percentage taken.
 *
 * Everything in this file concerns exactly one money flow: a pharmacy paying
 * Locum Planner a flat monthly subscription, plus the R10 late-cancellation
 * accountability charge that rides on the same invoice. There is deliberately
 * no table here for paying a locum, and adding one would change the product's
 * legal position on employment misclassification (§10.0) — not just its
 * architecture.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pharmacyId: uuid("pharmacy_id")
      .notNull()
      .references(() => pharmacies.id, { onDelete: "cascade" }),

    status: subscriptionStatus("status").notNull().default("trialing"),
    provider: paymentProvider("provider").notNull(),
    /** Provider-side token/reference for the recurring mandate. */
    providerRef: varchar("provider_ref", { length: 120 }),

    monthlyCents: integer("monthly_cents").notNull(),

    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),

    /**
     * §2 dunning. `restricted` means the pharmacy keeps its data and can still
     * be collected from, but cannot post new shifts — deliberately reversible,
     * because a card failing is usually an expiry, not a decision to leave.
     */
    restrictedAt: timestamp("restricted_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    uniqueIndex("subscriptions_pharmacy_active_key")
      .on(table.pharmacyId)
      .where(sql`${table.status} <> 'cancelled'`),
    index("subscriptions_status_idx").on(table.status),
    index("subscriptions_period_end_idx").on(table.currentPeriodEnd),
  ],
);

/**
 * One row per collection attempt, not one per invoice. The retry ladder in §2
 * is only auditable if every attempt — including the failures — is preserved
 * with its provider failure code.
 */
export const subscriptionCharges = pgTable(
  "subscription_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),

    /** Subscription + any late-cancellation fees for the period. */
    amountCents: integer("amount_cents").notNull(),
    status: chargeStatus("status").notNull().default("pending"),

    attempt: smallint("attempt").notNull().default(1),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),

    providerRef: varchar("provider_ref", { length: 120 }),
    failureCode: varchar("failure_code", { length: 60 }),
    failureDetail: text("failure_detail"),

    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),

    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    index("subscription_charges_subscription_idx").on(table.subscriptionId),
    // The dunning worker's hot query: what is due for retry right now.
    index("subscription_charges_retry_idx")
      .on(table.nextRetryAt)
      .where(sql`${table.status} = 'retrying'`),
    uniqueIndex("subscription_charges_provider_ref_key")
      .on(table.providerRef)
      .where(sql`${table.providerRef} is not null`),
  ],
);

/**
 * §9 — R10 added to the month's subscription when a confirmed shift is
 * cancelled with under 24 hours' notice.
 *
 * Framed as accountability, not revenue: small enough that nobody feels
 * robbed, real enough that a late cancellation carries a consequence — which
 * matters because a late cancellation can leave a pharmacy unable to trade.
 */
export const cancellationFees = pgTable(
  "cancellation_fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "restrict" }),

    amountCents: integer("amount_cents").notNull().default(1000),
    /** Hours of notice actually given — kept for dispute resolution. */
    noticeHours: smallint("notice_hours").notNull(),

    /** Null until the fee is rolled into a period's charge. */
    appliedToChargeId: uuid("applied_to_charge_id").references(
      () => subscriptionCharges.id,
      { onDelete: "set null" },
    ),

    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waivedReason: text("waived_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // A booking can only ever incur one late-cancellation fee.
    uniqueIndex("cancellation_fees_booking_key").on(table.bookingId),
    index("cancellation_fees_unapplied_idx")
      .on(table.subscriptionId)
      .where(sql`${table.appliedToChargeId} is null`),
  ],
);

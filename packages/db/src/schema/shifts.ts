import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { geographyPoint } from "../types/geography";
import { locumProfiles, pharmacies, users } from "./identity";
import { bookingStatus, shiftStatus, shiftVisibility } from "./enums";

const now = sql`now()`;

/**
 * §10.1 — a manager's saved regulars. The default audience for a new shift,
 * and the first ring of the Phase 3 proactive-matching fan-out.
 */
export const favouriteLocums = pgTable(
  "favourite_locums",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pharmacyId: uuid("pharmacy_id")
      .notNull()
      .references(() => pharmacies.id, { onDelete: "cascade" }),
    locumId: uuid("locum_id")
      .notNull()
      .references(() => locumProfiles.userId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    uniqueIndex("favourite_locums_unique").on(table.pharmacyId, table.locumId),
    // Fan-out reads by pharmacy; the locum-side index serves "who favourites me".
    index("favourite_locums_locum_idx").on(table.locumId),
  ],
);

export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pharmacyId: uuid("pharmacy_id")
      .notNull()
      .references(() => pharmacies.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),

    /**
     * Money in integer cents. Never a float — 0.1 + 0.2 problems in a column a
     * pharmacy reconciles against payroll are not recoverable trust-wise.
     * ZAR has two decimal places, so cents are exact.
     */
    hourlyRateCents: integer("hourly_rate_cents").notNull(),

    /** §10.1 — defaults to favourites-only; widening is an explicit action. */
    visibility: shiftVisibility("visibility")
      .notNull()
      .default("favourites_only"),
    /** Only meaningful when visibility = 'radius'. */
    radiusKm: integer("radius_km"),

    status: shiftStatus("status").notNull().default("draft"),

    /**
     * Denormalised from the pharmacy so proximity matching is a single-table
     * index scan. A pharmacy moving premises is rare enough to handle with a
     * backfill; joining on every match query is not worth it.
     */
    location: geographyPoint("location").notNull(),

    notes: text("notes"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    index("shifts_location_gist").using("gist", table.location),
    index("shifts_pharmacy_idx").on(table.pharmacyId),
    // Partial: the matching query only ever scans open, future shifts.
    index("shifts_open_starts_idx")
      .on(table.startsAt)
      .where(sql`${table.status} = 'open'`),
    index("shifts_status_idx").on(table.status),
  ],
);

/**
 * The single most important table in the system for correctness.
 *
 * A confirmed booking is what lets a pharmacy legally trade that day. Two
 * locums confirmed against one shift means one of them travels to Johannesburg
 * for a shift that is not theirs; zero confirmed when the manager thinks there
 * is one means the pharmacy cannot open. Both are business-ending failures,
 * so this table carries a *database-level* invariant rather than relying on
 * application logic being correct.
 *
 * Two mechanisms, deliberately overlapping:
 *
 *  1. `bookings_one_confirmed_per_shift` — a partial unique index. Even if
 *     every line of application code is wrong, Postgres will not permit a
 *     second confirmed booking against a shift. This is the real guarantee.
 *
 *  2. `SELECT ... FOR UPDATE` on the shift row in the confirm path (see
 *     packages/core). This serialises concurrent accepts so the loser gets a
 *     clean "already filled" domain error instead of a raw constraint
 *     violation surfacing as a 500.
 *
 * (1) without (2) is correct but produces terrible errors. (2) without (1) is
 * only as correct as the code around it. §12.4 requires the concurrency test
 * to fail when the fix is removed — which is why both are tested separately.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id, { onDelete: "cascade" }),
    locumId: uuid("locum_id")
      .notNull()
      .references(() => locumProfiles.userId, { onDelete: "restrict" }),

    status: bookingStatus("status").notNull().default("requested"),

    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .default(now),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, {
      onDelete: "set null",
    }),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, {
      onDelete: "set null",
    }),
    cancellationReason: text("cancellation_reason"),

    /**
     * §9 — set at cancellation time, not computed on read. The 24-hour rule is
     * evaluated against the shift start as it stood when the cancellation
     * happened; recomputing later would let a rescheduled shift retroactively
     * change whether a fee was owed.
     */
    wasLateCancellation: boolean("was_late_cancellation")
      .notNull()
      .default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // THE invariant. At most one confirmed booking per shift, enforced by
    // Postgres rather than by hope.
    uniqueIndex("bookings_one_confirmed_per_shift")
      .on(table.shiftId)
      .where(sql`${table.status} = 'confirmed'`),
    // A locum cannot have two live requests against the same shift.
    uniqueIndex("bookings_one_live_request_per_locum")
      .on(table.shiftId, table.locumId)
      .where(sql`${table.status} in ('requested', 'confirmed')`),
    index("bookings_locum_idx").on(table.locumId),
    index("bookings_status_idx").on(table.status),
  ],
);

/**
 * §8 — opt-in check-in/check-out. The output is an hours-worked record a
 * pharmacy hands to its own payroll (§10.0); the platform never pays anyone.
 */
export const checkIns = pgTable(
  "check_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),

    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkInLocation: geographyPoint("check_in_location"),
    checkInAccuracyM: smallint("check_in_accuracy_m"),

    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    checkOutLocation: geographyPoint("check_out_location"),
    checkOutAccuracyM: smallint("check_out_accuracy_m"),

    /**
     * §8/§16 — anti-spoofing. `mockLocationDetected` comes from Android's
     * `Location.isFromMockProvider()`, which has no browser equivalent; this is
     * precisely why §16 rules an emulator insufficient and requires a physical
     * device to close the gate.
     *
     * Recorded as signals rather than acted on automatically: a false positive
     * that voids a real pharmacist's shift record is worse than a missed spoof.
     * The manager sees a flag and decides.
     */
    mockLocationDetected: boolean("mock_location_detected"),
    deviceSignals: jsonb("device_signals"),

    /**
     * Distance from the pharmacy at check-in and check-out, in metres,
     * computed SERVER-SIDE from the pharmacy's stored location.
     *
     * Never accepted from the client: a distance the device reports is a
     * number the device chose, which is worthless as evidence. The client
     * supplies only a coordinate, and even that is treated as a claim.
     *
     * Check-out distance matters as much as check-in: a locum who checks out
     * from home an hour early is exactly the case an hours-worked record needs
     * to make visible (§10.0).
     */
    checkInDistanceM: integer("check_in_distance_m"),
    checkOutDistanceM: integer("check_out_distance_m"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    uniqueIndex("check_ins_booking_key").on(table.bookingId),
    index("check_ins_mock_idx")
      .on(table.mockLocationDetected)
      .where(sql`${table.mockLocationDetected} = true`),
  ],
);

/**
 * §7 — unified reputation. Density-aware anonymisation is applied at read
 * time: in a thin metro, showing "the locum who rated you 2 stars" is
 * effectively naming them, so ratings are only surfaced individually once a
 * ratee has enough of them to hide in.
 */
export const ratings = pgTable(
  "ratings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    raterId: uuid("rater_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rateeId: uuid("ratee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    score: smallint("score").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // One rating per direction per booking.
    uniqueIndex("ratings_booking_rater_key").on(table.bookingId, table.raterId),
    index("ratings_ratee_idx").on(table.rateeId),
  ],
);

/**
 * §6 — time-gated messaging with disintermediation detection. All of it routes
 * through the platform sender (§10.1): no personal numbers are ever exchanged.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id").references(() => bookings.id, {
      onDelete: "cascade",
    }),
    shiftId: uuid("shift_id").references(() => shifts.id, {
      onDelete: "cascade",
    }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),

    /**
     * §6/§14 — the regex flags; a human adjudicates. The false-positive rate
     * is meaningless until measured against the hand-labelled corpus, so
     * flagged messages are still delivered and merely recorded.
     */
    flaggedDisintermediation: boolean("flagged_disintermediation")
      .notNull()
      .default(false),
    flagReason: varchar("flag_reason", { length: 120 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    index("messages_booking_idx").on(table.bookingId),
    index("messages_flagged_idx")
      .on(table.createdAt)
      .where(sql`${table.flaggedDisintermediation} = true`),
  ],
);

/**
 * §12.3 — who has been offered which shift, and in which ring.
 *
 * A durable record rather than a transient list, for three reasons:
 *
 *   1. Escalation happens minutes apart in a different process. Ring 2 must
 *      know who ring 0 already reached, and "who did we message" cannot live
 *      in the memory of whichever worker happened to run first.
 *   2. It is the dedupe key. The unique index makes "notified twice about the
 *      same shift" impossible at the database level rather than dependent on
 *      the fan-out getting its exclusion list right — and a duplicate here is
 *      a real WhatsApp message to a real person, which cannot be taken back.
 *   3. It is what the §12.3 load-test verifier reads. k6 measures latency;
 *      whether the fan-out respected `max_travel_km` under burst is a
 *      database question, answered afterwards from these rows.
 */
export const shiftOffers = pgTable(
  "shift_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id, { onDelete: "cascade" }),
    locumId: uuid("locum_id")
      .notNull()
      .references(() => locumProfiles.userId, { onDelete: "cascade" }),

    /** 0 = favourites; 1..n = distance bands. */
    ring: integer("ring").notNull(),
    /**
     * Metres at the moment of the offer, not recomputed later.
     *
     * A locum who moves house afterwards would otherwise make a past offer
     * look like it broke the distance rule — which matters because these rows
     * are the evidence the §12.3 gate is checked against.
     */
    distanceM: integer("distance_m").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // The invariant, at the database level: one offer per locum per shift.
    uniqueIndex("shift_offers_unique").on(table.shiftId, table.locumId),
    index("shift_offers_shift_idx").on(table.shiftId),
  ],
);

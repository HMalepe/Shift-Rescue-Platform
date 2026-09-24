import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { geographyPoint } from "../types/geography";
import {
  documentType,
  nearbyNudgeFrequency,
  scanStatus,
  userRole,
  verificationStatus,
} from "./enums";

const now = sql`now()`;

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: userRole("role").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    /** E.164. The platform's own WhatsApp sender messages this; it is never
     *  exposed to the other party (§10.1). */
    phone: varchar("phone", { length: 20 }),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    passwordHash: text("password_hash"),

    /**
     * §12.1 — admin accounts can mark employment "verified" and are therefore
     * a high-value social-engineering target. MFA is required for them; the
     * enrolment secret lives here so a login can assert it exists.
     */
    mfaSecret: text("mfa_secret"),
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
    /**
     * §12.1 — single-use enforcement for TOTP codes.
     *
     * `verifyTotp` alone accepts any code in the ±90s window every time it is
     * presented, so a shoulder-surfed code stays valid until it naturally
     * expires. This is the counter of the last code actually consumed; a
     * login is only accepted if its matched counter is strictly greater,
     * enforced with a conditional UPDATE rather than a separate check, so two
     * concurrent logins racing the same code cannot both win.
     */
    mfaLastUsedCounter: integer("mfa_last_used_counter"),

    /**
     * §12.1 — sessions must be invalidatable on password change. Rather than
     * tracking every issued token, tokens carry an issued-at and are rejected
     * if older than this watermark. One UPDATE logs a user out everywhere.
     */
    sessionsValidFrom: timestamp("sessions_valid_from", { withTimezone: true })
      .notNull()
      .default(now),

    /** §10 POPIA: general consent captured at onboarding. */
    popiaConsentAt: timestamp("popia_consent_at", { withTimezone: true }),

    /**
     * §10 — set when the right to erasure has been exercised.
     *
     * A tombstone rather than a deleted row: every booking, rating and
     * attendance record in the system points here by foreign key, and those
     * belong to the pharmacy as much as to the person. The row survives with
     * its identifying columns overwritten — see packages/core/src/privacy.
     *
     * Nullable and indexed so listings can exclude erased subjects cheaply. A
     * boolean would have lost WHEN, which is the part a regulator asks about.
     */
    erasedAt: timestamp("erased_at", { withTimezone: true }),

    /**
     * §11.4 — Meta requires a WhatsApp opt-in that is *separate* from POPIA
     * consent, with a working STOP path. Kept as two nullable timestamps
     * rather than one boolean so the audit trail shows when each happened.
     */
    whatsappOptInAt: timestamp("whatsapp_opt_in_at", { withTimezone: true }),
    whatsappOptOutAt: timestamp("whatsapp_opt_out_at", { withTimezone: true }),

    /** §4.4 — notifications inside quiet hours are queued to 07:00, not dropped. */
    quietHoursStart: time("quiet_hours_start").notNull().default("21:00"),
    quietHoursEnd: time("quiet_hours_end").notNull().default("07:00"),

    /**
     * "N locums near you" / "N pharmacies hiring near you". Real-time
     * reciprocal matching (someone toggling available/looking near this user
     * right now) bypasses this and sends immediately regardless of cadence —
     * this only throttles the idle-digest fallback, so a `daily` user is not
     * re-told the same count every hour on a quiet day.
     */
    nearbyNudgeFrequency: nearbyNudgeFrequency("nearby_nudge_frequency")
      .notNull()
      .default("daily"),
    nearbyNudgeLastSentAt: timestamp("nearby_nudge_last_sent_at", {
      withTimezone: true,
    }),

    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // One person may be a pharmacy manager and an admin. Uniqueness is per role,
    // so the two accounts can share an email and still have different passwords.
    uniqueIndex("users_email_role_key").on(sql`lower(${table.email})`, table.role),
    uniqueIndex("users_phone_key")
      .on(table.phone)
      .where(sql`${table.phone} is not null`),
    index("users_role_idx").on(table.role),
  ],
);

export const pharmacies = pgTable(
  "pharmacies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    tradingName: varchar("trading_name", { length: 200 }),
    /** SAPC pharmacy registration number, distinct from a pharmacist's. */
    sapcPharmacyNumber: varchar("sapc_pharmacy_number", { length: 32 }),
    addressLine: text("address_line").notNull(),
    suburb: varchar("suburb", { length: 120 }),
    city: varchar("city", { length: 120 }).notNull(),
    province: varchar("province", { length: 60 }).notNull().default("Gauteng"),
    postalCode: varchar("postal_code", { length: 10 }),
    location: geographyPoint("location").notNull(),
    verification: verificationStatus("verification")
      .notNull()
      .default("incomplete"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    // GiST is what makes ST_DWithin an index scan rather than a seq scan.
    // §15 gates this with EXPLAIN ANALYZE against seeded data.
    index("pharmacies_location_gist").using("gist", table.location),
    index("pharmacies_city_idx").on(table.city),
    uniqueIndex("pharmacies_sapc_key")
      .on(sql`lower(${table.sapcPharmacyNumber})`)
      .where(sql`${table.sapcPharmacyNumber} is not null`),
  ],
);

/**
 * A manager may run more than one branch, and a branch may have more than one
 * manager. Modelled as a join table from the start because retrofitting
 * many-to-many onto a `pharmacy_id` column on users is a painful migration.
 */
export const pharmacyMembers = pgTable(
  "pharmacy_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pharmacyId: uuid("pharmacy_id")
      .notNull()
      .references(() => pharmacies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    uniqueIndex("pharmacy_members_unique").on(table.pharmacyId, table.userId),
    uniqueIndex("pharmacy_members_one_primary")
      .on(table.userId)
      .where(sql`${table.isPrimary} = true`),
    index("pharmacy_members_user_idx").on(table.userId),
  ],
);

export const locumProfiles = pgTable(
  "locum_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),

    /** SAPC registration number — the thing a manager is really buying trust in. */
    sapcNumber: varchar("sapc_number", { length: 32 }),
    verification: verificationStatus("verification")
      .notNull()
      .default("incomplete"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** §12.1 — every verification decision is attributable to a named admin. */
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * Home base for proximity matching. Deliberately not the live device
     * location: §8 check-in location is captured per-booking and is opt-in,
     * whereas this is a standing preference the locum sets once.
     */
    baseLocation: geographyPoint("base_location"),
    maxTravelKm: integer("max_travel_km").notNull().default(25),

    /**
     * §7 reputation. Stored denormalised because it is read on every match and
     * recomputed only when a booking reaches a terminal state.
     */
    reliabilityScore: smallint("reliability_score"),
    completedShifts: integer("completed_shifts").notNull().default(0),
    lateCancellations: integer("late_cancellations").notNull().default(0),
    noShows: integer("no_shows").notNull().default(0),

    /**
     * §5 — availability lapses. A stale "available" flag is worse than no flag,
     * because a manager acts on it. The nudge job reads this.
     */
    availableFrom: timestamp("available_from", { withTimezone: true }),
    availabilityConfirmedAt: timestamp("availability_confirmed_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    index("locum_profiles_base_location_gist").using(
      "gist",
      table.baseLocation,
    ),
    index("locum_profiles_verification_idx").on(table.verification),
    uniqueIndex("locum_profiles_sapc_key")
      .on(sql`lower(${table.sapcNumber})`)
      .where(sql`${table.sapcNumber} is not null`),
  ],
);

/**
 * One professional registration number belongs to one email, and one email
 * has one number, whether that email is a locum, a pharmacy manager, or both.
 * Admin accounts are not registered here.
 */
export const professionalRegistrations = pgTable(
  "professional_registrations",
  {
    number: varchar("number", { length: 32 }).primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
  },
  (table) => [
    uniqueIndex("professional_registrations_email_key").on(sql`lower(${table.email})`),
  ],
);

/**
 * §12.1 — certificates, payslips and employment letters are personal and
 * employment data. They are never public objects: retrieval is via a signed
 * URL that expires, and nothing is servable before the scan reaches `clean`.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pharmacyId: uuid("pharmacy_id").references(() => pharmacies.id, {
      onDelete: "cascade",
    }),
    type: documentType("type").notNull(),

    /** Object-store key. Never a public URL — see §12.1 on signed-URL expiry. */
    storageKey: text("storage_key").notNull(),
    /** Server-detected, not the client-supplied Content-Type. */
    detectedMimeType: varchar("detected_mime_type", { length: 120 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),

    scan: scanStatus("scan").notNull().default("pending"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    scanDetail: text("scan_detail"),

    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    index("documents_user_idx").on(table.userId),
    index("documents_scan_idx").on(table.scan),
    // Identical uploads dedupe to one scan.
    index("documents_sha256_idx").on(table.sha256),
  ],
);

/**
 * §12.1 — every verification decision is logged with the reviewing admin's
 * identity. Append-only by convention; no UPDATE path exists in application
 * code.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 80 }).notNull(),
    subjectType: varchar("subject_type", { length: 60 }).notNull(),
    subjectId: uuid("subject_id"),
    /** Freeform context: before/after values, rejection reason, request IP. */
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(now),
  },
  (table) => [
    index("audit_log_subject_idx").on(table.subjectType, table.subjectId),
    index("audit_log_actor_idx").on(table.actorId),
    index("audit_log_created_idx").on(table.createdAt),
  ],
);

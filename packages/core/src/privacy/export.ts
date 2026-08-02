import { eq, or, sql } from "drizzle-orm";
import {
  auditLog,
  authAttempts,
  bookings,
  checkIns,
  documents,
  favouriteLocums,
  locumProfiles,
  messages,
  pharmacyMembers,
  rateLimitCounters,
  ratings,
  sessions,
  users,
  whatsappMessageLog,
  type Database,
} from "@locum/db";
import { DomainError } from "../errors";

/**
 * §10 — the right of access.
 *
 * POPIA entitles a data subject to know what is held about them. The
 * temptation is a tidy summary; the obligation is everything.
 *
 * ## An incomplete export is worse than none
 *
 * A partial export is a document that says "this is what we hold" while
 * omitting the GPS trace of every shift someone worked. The subject reads it,
 * concludes the platform holds little, and makes decisions on that basis.
 * That is a more damaging outcome than no export at all, which at least
 * prompts them to ask.
 *
 * So this function is written to be *auditable against the schema* rather than
 * to look neat: every table that references a user appears here, including the
 * ones that turn out to hold almost nothing. The privacy gate test asserts
 * that the set of tables covered here matches the retention policy, which in
 * turn is asserted against the schema — so a new table holding personal data
 * cannot be added without either appearing in the export or failing the build.
 *
 * ## What is deliberately NOT included
 *
 * Password and MFA secrets. They are held about the subject, and returning
 * them would turn a routine data request into a credential disclosure —
 * particularly since the most likely reason someone requests an export at a
 * suspicious moment is that they are not the account holder. The export says
 * that a password is set; it does not say what it hashes to.
 */

export interface DataExport {
  readonly subjectId: string;
  readonly generatedAt: Date;
  readonly account: Record<string, unknown>;
  readonly locumProfile: Record<string, unknown> | null;
  readonly pharmacyMemberships: ReadonlyArray<Record<string, unknown>>;
  readonly bookings: ReadonlyArray<Record<string, unknown>>;
  readonly attendance: ReadonlyArray<Record<string, unknown>>;
  readonly documents: ReadonlyArray<Record<string, unknown>>;
  readonly messagesSent: ReadonlyArray<Record<string, unknown>>;
  readonly ratingsGiven: ReadonlyArray<Record<string, unknown>>;
  readonly ratingsReceived: ReadonlyArray<Record<string, unknown>>;
  readonly whatsappMessages: ReadonlyArray<Record<string, unknown>>;
  readonly activeSessions: ReadonlyArray<Record<string, unknown>>;
  readonly loginAttempts: ReadonlyArray<Record<string, unknown>>;
  readonly savedByPharmacies: ReadonlyArray<Record<string, unknown>>;
  readonly usageCounters: ReadonlyArray<Record<string, unknown>>;
  readonly decisionsAboutYou: ReadonlyArray<Record<string, unknown>>;
  /** Plain-language note on what is held and what is withheld, and why. */
  readonly notes: ReadonlyArray<string>;
}

/** Tables this export reads from. Asserted against the retention policy. */
export const EXPORTED_TABLES: readonly string[] = [
  "users",
  "locum_profiles",
  "pharmacy_members",
  "bookings",
  "check_ins",
  "documents",
  "messages",
  "ratings",
  "whatsapp_message_log",
  "sessions",
  "auth_attempts",
  "favourite_locums",
  "rate_limit_counters",
  "audit_log",
];

export async function exportSubjectData(
  db: Database,
  subjectId: string,
): Promise<DataExport> {
  const [account] = await db
    .select({
      id: users.id,
      role: users.role,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      createdAt: users.createdAt,
      disabledAt: users.disabledAt,
      popiaConsentAt: users.popiaConsentAt,
      whatsappOptInAt: users.whatsappOptInAt,
      whatsappOptOutAt: users.whatsappOptOutAt,
      quietHoursStart: users.quietHoursStart,
      quietHoursEnd: users.quietHoursEnd,
      // Presence, never the value. See the note above.
      hasPassword: sql<boolean>`${users.passwordHash} is not null`,
      mfaEnrolledAt: users.mfaEnrolledAt,
    })
    .from(users)
    .where(eq(users.id, subjectId))
    .limit(1);

  if (!account) {
    throw new DomainError("SUBJECT_NOT_FOUND", "No such account", { subjectId });
  }

  const [
    profile,
    memberships,
    bookingRows,
    attendance,
    documentRows,
    messageRows,
    given,
    received,
    whatsapp,
    activeSessions,
    loginAttempts,
    savedBy,
    usageCounters,
    decisions,
  ] = await Promise.all([
    db.select().from(locumProfiles).where(eq(locumProfiles.userId, subjectId)),
    db.select().from(pharmacyMembers).where(eq(pharmacyMembers.userId, subjectId)),
    db.select().from(bookings).where(eq(bookings.locumId, subjectId)),
    /*
     * Attendance is reached through the subject's bookings rather than held
     * directly, and it is the single most invasive thing on this list — a GPS
     * coordinate and accuracy radius for every arrival and departure. Omitting
     * it because it is awkward to join is exactly the failure this file exists
     * to avoid.
     */
    db
      .select()
      .from(checkIns)
      .innerJoin(bookings, eq(bookings.id, checkIns.bookingId))
      .where(eq(bookings.locumId, subjectId)),
    /*
     * Metadata only. The document CONTENT is not inlined — an export
     * containing a copy of someone's ID document is a file that then exists in
     * their downloads folder and their email. They can request the originals
     * through the signed-URL path, which expires.
     */
    db
      .select({
        id: documents.id,
        type: documents.type,
        sizeBytes: documents.sizeBytes,
        scan: documents.scan,
        createdAt: documents.createdAt,
        reviewedAt: documents.reviewedAt,
      })
      .from(documents)
      .where(eq(documents.userId, subjectId)),
    db.select().from(messages).where(eq(messages.senderId, subjectId)),
    /*
     * Ratings given are included with their scores — they are the subject's
     * own words about someone else, and POPIA's access right covers what the
     * subject wrote.
     */
    db.select().from(ratings).where(eq(ratings.raterId, subjectId)),
    /*
     * Ratings RECEIVED are returned WITHOUT the rater's identity. §7's entire
     * anonymisation design would be defeated by a data-subject request that
     * returns "who said what about you" — and the person entitled to access
     * here is the ratee, not the raters.
     */
    db
      .select({
        id: ratings.id,
        bookingId: ratings.bookingId,
        score: ratings.score,
        comment: ratings.comment,
        createdAt: ratings.createdAt,
      })
      .from(ratings)
      .where(eq(ratings.rateeId, subjectId)),
    db.select().from(whatsappMessageLog).where(eq(whatsappMessageLog.userId, subjectId)),
    db
      .select({
        id: sessions.id,
        issuedAt: sessions.issuedAt,
        revokedAt: sessions.revokedAt,
        ipAddress: sessions.ipAddress,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, subjectId)),
    /*
     * Login attempts, including failures. Personal data — timestamps and IP
     * addresses tied to an identity — and the subject is entitled to them.
     * Added because the gate test noticed they were being ERASED but never
     * DISCLOSED, which is an inconsistency a subject could never see.
     */
    db
      .select({
        identifier: authAttempts.identifier,
        ipAddress: authAttempts.ipAddress,
        successful: authAttempts.successful,
        createdAt: authAttempts.createdAt,
      })
      .from(authAttempts)
      .where(eq(authAttempts.identifier, account.email)),
    /*
     * Which pharmacies saved this locum as a regular. Meaningful personal
     * information — it is who considers you one of theirs, and it determines
     * which shifts you are shown first (§10.1).
     */
    db.select().from(favouriteLocums).where(eq(favouriteLocums.locumId, subjectId)),
    /*
     * §12.1 rate-limit counters. How often this account browsed or applied,
     * in one-hour buckets — a coarse activity log, and therefore personal
     * data. Disclosed for the same reason the policy erases it: the retention
     * test refuses any table that is one without being the other.
     */
    db
      .select()
      .from(rateLimitCounters)
      .where(eq(rateLimitCounters.subjectId, subjectId)),
    /*
     * §12.1 logs every verification decision with the reviewing admin's
     * identity. The subject is entitled to know a decision was made about
     * them; the reviewing admin's identity is withheld, because a locum who
     * was rejected knowing exactly which named person rejected them is a
     * safety problem for that person, not a transparency win.
     */
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        subjectType: auditLog.subjectType,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(or(eq(auditLog.subjectId, subjectId), eq(auditLog.actorId, subjectId))),
  ]);

  return {
    subjectId,
    generatedAt: new Date(),
    account,
    locumProfile: profile[0] ?? null,
    pharmacyMemberships: memberships,
    bookings: bookingRows,
    attendance: attendance.map((row) => row.check_ins),
    documents: documentRows,
    messagesSent: messageRows,
    ratingsGiven: given,
    ratingsReceived: received,
    whatsappMessages: whatsapp,
    activeSessions,
    loginAttempts,
    savedByPharmacies: savedBy,
    usageCounters,
    decisionsAboutYou: decisions,
    notes: [
      "This is everything Locum Planner holds about you, across every table.",
      "Your password and authenticator secret are deliberately excluded: returning them would turn a data request into a way of stealing an account.",
      "Documents are listed but their contents are not attached — request the originals separately and the link will expire.",
      "Ratings you received are shown without who left them. Ratings are anonymous by design, and that protects the people who rated you honestly.",
      "Decisions made about your verification are listed without naming the reviewer.",
      "Locum Planner never handles wages. Nothing here is a payment to you; your pay comes from the pharmacy's own payroll.",
    ],
  };
}

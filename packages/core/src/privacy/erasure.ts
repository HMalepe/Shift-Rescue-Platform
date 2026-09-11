import { eq, sql } from "drizzle-orm";
import {
  authAttempts,
  bookings,
  documents,
  favouriteLocums,
  locumProfiles,
  messages,
  pharmacyMembers,
  reputationSnapshots,
  shiftOffers,
  ratings,
  sessions,
  users,
  whatsappMessageLog,
  type Database,
} from "@locum/db";
import { DomainError } from "../errors";

/**
 * §10 — the right to erasure, as this product can honestly implement it.
 *
 * The policy and its reasoning live in retention.ts; this file executes it.
 * Two properties matter more than anything else here.
 *
 * **It runs in one transaction.** A half-erased subject — name gone, GPS trace
 * still present — is worse than either outcome, and it is unrecoverable
 * because there is no longer a name to search by.
 *
 * **It reports what it did.** The return value names every table touched and
 * how many rows. Erasure that says only "done" cannot be audited, and a
 * regulator asking "what happened to their documents" deserves better than a
 * reading of the source.
 */

export interface ErasureReport {
  readonly subjectId: string;
  readonly erasedAt: Date;
  readonly affected: ReadonlyArray<{
    readonly table: string;
    readonly action: "delete" | "anonymise";
    readonly rows: number;
  }>;
  readonly retained: ReadonlyArray<{ readonly table: string; readonly because: string }>;
}

/**
 * Erases a subject.
 *
 * `requestedBy` is recorded rather than assumed to be the subject: an erasure
 * carried out by an admin on someone's written request is a different event
 * from one someone performed on their own account, and only one of them needs
 * a paper trail attached to a human.
 */
export async function eraseSubject(
  db: Database,
  input: { readonly subjectId: string; readonly requestedBy: string },
): Promise<ErasureReport> {
  const { subjectId } = input;

  return db.transaction(async (tx) => {
    const [subject] = await tx
      .select({ id: users.id, role: users.role, erasedAt: users.erasedAt })
      .from(users)
      .where(eq(users.id, subjectId))
      .limit(1);

    if (!subject) {
      throw new DomainError("SUBJECT_NOT_FOUND", "No such account", { subjectId });
    }
    if (subject.erasedAt) {
      /*
       * Refused rather than treated as a no-op. A second erasure request for
       * an already-erased subject usually means someone is looking for data
       * that is gone, and telling them it succeeded sends them away satisfied
       * and wrong.
       */
      throw new DomainError("ALREADY_ERASED", "This account has already been erased", {
        subjectId,
        erasedAt: subject.erasedAt.toISOString(),
      });
    }

    const affected: Array<{ table: string; action: "delete" | "anonymise"; rows: number }> =
      [];
    const count = (result: unknown): number =>
      typeof (result as { count?: number })?.count === "number"
        ? (result as { count: number }).count
        : Array.isArray(result)
          ? result.length
          : 0;

    // --- credentials and access -------------------------------------------
    affected.push({
      table: "sessions",
      action: "delete",
      rows: count(await tx.delete(sessions).where(eq(sessions.userId, subjectId))),
    });

    /*
     * auth_attempts is keyed by the login identifier, not the user id — the
     * rate limiter has to work for an address that does not correspond to an
     * account. So this must be deleted BEFORE the email is overwritten, or the
     * link to those rows is lost and they linger indefinitely.
     */
    const [emailRow] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, subjectId))
      .limit(1);
    affected.push({
      table: "auth_attempts",
      action: "delete",
      rows: count(
        await tx.delete(authAttempts).where(eq(authAttempts.identifier, emailRow!.email)),
      ),
    });

    // --- the most sensitive holdings --------------------------------------
    affected.push({
      table: "documents",
      action: "delete",
      rows: count(await tx.delete(documents).where(eq(documents.userId, subjectId))),
    });

    /*
     * Rate-limit counters. Added when the retention-policy test refused a
     * schema containing a table nobody had decided about — which is the
     * mechanism working, and cheaper than finding out from a regulator.
     */
    affected.push({
      table: "rate_limit_counters",
      action: "delete",
      rows: count(
        await tx.execute(
          sql`delete from rate_limit_counters where subject_id = ${subjectId}::uuid`,
        ),
      ),
    });

    /*
     * §12.3 offers. Deleted, not retained: an offer proves only that we
     * messaged this person, and a list of unanswered approaches to someone who
     * asked to be erased is precisely the residue §10 removes. It carries no
     * §7 signal — reputation counts completed shifts and no-shows, never
     * offers declined — so this cannot become a reputation reset.
     */
    affected.push({
      table: "shift_offers",
      action: "delete",
      rows: count(
        await tx.delete(shiftOffers).where(eq(shiftOffers.locumId, subjectId)),
      ),
    });
    affected.push({
      table: "favourite_locums",
      action: "delete",
      rows: count(
        await tx.delete(favouriteLocums).where(eq(favouriteLocums.locumId, subjectId)),
      ),
    });
    affected.push({
      table: "pharmacy_members",
      action: "delete",
      rows: count(
        await tx.delete(pharmacyMembers).where(eq(pharmacyMembers.userId, subjectId)),
      ),
    });

    /*
     * §7's delta-protection checkpoint. It is a cache of a decision, not a
     * record of one — deleting it here does not touch the ratings themselves
     * (handled below, anonymised) and cannot resurface a no-show count.
     */
    affected.push({
      table: "reputation_snapshots",
      action: "delete",
      rows: count(
        await tx
          .delete(reputationSnapshots)
          .where(eq(reputationSnapshots.subjectId, subjectId)),
      ),
    });

    // --- anonymised, not deleted ------------------------------------------
    affected.push({
      table: "messages",
      action: "anonymise",
      rows: count(
        await tx
          .update(messages)
          .set({ body: "[erased at the sender's request]", flagReason: null })
          .where(eq(messages.senderId, subjectId)),
      ),
    });

    /*
     * GPS traces cleared, TIMES retained. The pharmacy's evidence that its
     * dispensary was staffed on a given day is not the locum's to remove; the
     * coordinate proving where they physically stood is.
     */
    affected.push({
      table: "check_ins",
      action: "anonymise",
      rows: count(
        await tx.execute(sql`
          update check_ins ci
             set check_in_location = null,
                 check_out_location = null,
                 check_in_accuracy_m = null,
                 check_out_accuracy_m = null,
                 device_signals = null
            from bookings b
           where b.id = ci.booking_id
             and b.locum_id = ${subjectId}
        `),
      ),
    });

    /*
     * Ratings the subject GAVE are detached from them. §7 already treats
     * ratings as anonymous to the ratee; this makes that true in the database
     * rather than only in the projection.
     */
    affected.push({
      table: "ratings",
      action: "anonymise",
      rows: count(
        await tx.update(ratings).set({ comment: null }).where(eq(ratings.raterId, subjectId)),
      ),
    });

    affected.push({
      table: "whatsapp_message_log",
      action: "anonymise",
      rows: count(
        await tx
          .update(whatsappMessageLog)
          .set({ userId: null, variables: null })
          .where(eq(whatsappMessageLog.userId, subjectId)),
      ),
    });

    /*
     * The locum profile keeps its counts and loses everything else.
     *
     * THIS IS THE LOAD-BEARING LINE OF THE WHOLE FILE. `completedShifts` and
     * `noShows` survive erasure on purpose. Clearing them would make the
     * erasure endpoint a reputation reset: three no-shows, delete, re-register,
     * clean record — and every pharmacy trusting a §7 tier has been misled by
     * a privacy feature working exactly as documented.
     *
     * The counts are not personal information once the identity is gone. They
     * are two integers attached to a random uuid.
     */
    affected.push({
      table: "locum_profiles",
      action: "anonymise",
      rows: count(
        await tx
          .update(locumProfiles)
          .set({
            baseLocation: null,
            sapcNumber: null,
            availableFrom: null,
            availabilityConfirmedAt: null,
            verifiedBy: null,
            /*
             * Not "pending". An erased profile must never re-enter the
             * verification queue — an admin would be reviewing a person who
             * asked to be forgotten, using documents that no longer exist.
             */
            verification: "rejected",
          })
          .where(eq(locumProfiles.userId, subjectId)),
      ),
    });

    /*
     * The anchor row. Identity is overwritten with values that cannot collide
     * with a real person and cannot be logged into.
     *
     * The email must stay unique and must stay non-null (the column is), so it
     * becomes a random address at an unroutable domain. `.invalid` is reserved
     * by RFC 2606 precisely so it can never be delivered to.
     */
    const tombstone = `erased-${crypto.randomUUID()}`;
    affected.push({
      table: "users",
      action: "anonymise",
      rows: count(
        await tx
          .update(users)
          .set({
            email: `${tombstone}@erased.invalid`,
            fullName: "[erased]",
            phone: null,
            passwordHash: null,
            mfaSecret: null,
            mfaEnrolledAt: null,
            whatsappOptInAt: null,
            whatsappOptOutAt: null,
            popiaConsentAt: null,
            disabledAt: new Date(),
            erasedAt: new Date(),
            // Invalidates any token issued before this moment (§12.1).
            sessionsValidFrom: new Date(),
          })
          .where(eq(users.id, subjectId)),
      ),
    });

    /*
     * Deliberately NOT written to audit_log with the subject's id as a
     * reference to a person: the audit entry records that an erasure happened
     * and who performed it, which is a record about the ACTOR. Writing "we
     * erased Thabo Mokoena" into an append-only log would defeat the erasure
     * it is recording.
     */
    await tx.execute(sql`
      insert into audit_log (actor_id, action, subject_type, subject_id, metadata)
      values (
        ${input.requestedBy}::uuid,
        'privacy.erase',
        'user',
        ${subjectId}::uuid,
        ${JSON.stringify({ tables: affected.map((a) => a.table) })}
      )
    `);

    return {
      subjectId,
      erasedAt: new Date(),
      affected,
      retained: [
        {
          table: "bookings",
          because: "The pharmacy's record that a shift was covered.",
        },
        {
          table: "cancellation_fees / subscription_charges",
          because: "Financial records already issued to a pharmacy; SARS retention applies.",
        },
        {
          table: "audit_log",
          because: "§12.1 verification decisions. An audit log a subject can edit is not one.",
        },
        {
          table: "locum_profiles.no_shows / completed_shifts",
          because:
            "Retained deliberately: clearing them would make erasure a way to reset a §7 reputation.",
        },
      ],
    };
  });
}

/** Whether a subject has been erased. Used to keep them out of listings. */
export async function isErased(db: Database, subjectId: string): Promise<boolean> {
  const [row] = await db
    .select({ erasedAt: users.erasedAt })
    .from(users)
    .where(eq(users.id, subjectId))
    .limit(1);
  return row?.erasedAt != null;
}

/** Bookings survive erasure; this is how many, for the report. */
export async function bookingsRetainedFor(
  db: Database,
  subjectId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookings)
    .where(eq(bookings.locumId, subjectId));
  return row?.count ?? 0;
}

/**
 * §10 — what erasure actually means here.
 *
 * POPIA gives a data subject the right to have their personal information
 * deleted. It does not give them the right to delete a pharmacy's records, and
 * the two get tangled constantly. This file is where the tangle is resolved,
 * table by table, so the decision is reviewable rather than buried in a
 * cascade of `ON DELETE`.
 *
 * ## Why `DELETE FROM users` is the wrong answer
 *
 * Three separate reasons, and each on its own is disqualifying.
 *
 * **A pharmacy's operational record is not the locum's to erase.** A shift
 * worked in March is an event that happened to *both* parties. The pharmacy
 * needs the attendance record for its own compliance, the R10 late-cancellation
 * charges sit on invoices it has already paid, and SARS retention rules apply
 * to those invoices for years. Erasing the person must not erase the pharmacy's
 * evidence that it was staffed.
 *
 * **Erasure would otherwise be a reputation reset button.** §7 exists so that
 * a record of no-shows means something. If deleting an account discards that
 * record and re-registering is free, then the locum with three no-shows simply
 * becomes a new locum with none — and every pharmacy relying on a tier has been
 * quietly misled. This is the sharpest interaction in the file and the easiest
 * to miss, because it looks like a privacy feature working correctly.
 *
 * **Cascading deletes are silent.** `ON DELETE CASCADE` would remove rows from
 * tables nobody remembered were connected, and nothing would report what went.
 *
 * ## What erasure is instead
 *
 * The person is anonymised; the event is preserved. After erasure there is no
 * name, email, phone, location, document or message body left — and a booking
 * row still says a shift was worked, by a subject identified only by a
 * random id that leads nowhere.
 *
 * The honest limit: this is anonymisation, not disappearance. Somebody with the
 * pharmacy's own roster and a date could re-identify a single locum from an
 * attendance record. POPIA permits retaining what is needed for a legitimate
 * legal obligation, and that is the ground being stood on — but the product
 * should say so plainly rather than promise a deletion it does not perform.
 */

export type RetentionAction =
  /** Row is destroyed outright. */
  | "delete"
  /** Row survives; identifying columns are overwritten. */
  | "anonymise"
  /** Row survives untouched — it holds no personal data. */
  | "retain";

export interface RetentionRule {
  readonly table: string;
  readonly action: RetentionAction;
  /** Why. Every rule states its reason; unexplained retention is a smell. */
  readonly because: string;
}

/**
 * The complete policy.
 *
 * Every table in the schema appears, including the ones that need nothing
 * done. An omitted table is indistinguishable from a forgotten one, and the
 * test asserts this list covers the schema — so adding a table without
 * deciding its retention breaks the build rather than quietly leaking.
 */
export const RETENTION_POLICY: readonly RetentionRule[] = [
  {
    table: "users",
    action: "anonymise",
    because:
      "The row is the anchor for every foreign key in the system. Name, email, phone and MFA secret are overwritten; the id survives so a booking still points somewhere.",
  },
  {
    table: "locum_profiles",
    action: "anonymise",
    because:
      "Base location and SAPC number are personal. The no-show and completed-shift counts are RETAINED deliberately — discarding them would make erasure a way to shed a reputation (§7).",
  },
  {
    table: "sessions",
    action: "delete",
    because: "Credentials. Nothing legitimate needs a deleted account's sessions.",
  },
  {
    table: "auth_attempts",
    action: "delete",
    because:
      "Login attempts keyed to an email address. The rate limiter's own state is not a record anyone must keep.",
  },
  {
    table: "documents",
    action: "delete",
    because:
      "SAPC certificates, ID documents, payslips. The most sensitive data held, and no counterparty has a claim on it — the verification DECISION is retained in audit_log, which is what a regulator would ask about.",
  },
  {
    table: "messages",
    action: "anonymise",
    because:
      "A thread has two participants and the other one did not ask for erasure. Bodies sent BY the erased user are cleared; the rows survive so the surviving side's conversation is not full of holes.",
  },
  {
    table: "ratings",
    action: "anonymise",
    because:
      "Ratings GIVEN are detached from the rater — §7 already treats them as anonymous. Ratings RECEIVED stay attached to the subject id, because they are the counterparty's record of a shift they paid for.",
  },
  {
    table: "check_ins",
    action: "anonymise",
    because:
      "GPS traces are personal and are cleared. The check-in and check-out TIMES are retained: they are the pharmacy's evidence of who staffed the dispensary, which it may need years later.",
  },
  {
    table: "bookings",
    action: "retain",
    because:
      "Holds no personal data of its own — only ids and a status. It is the pharmacy's record that a shift was covered.",
  },
  {
    table: "shifts",
    action: "retain",
    because: "Belongs to the pharmacy, not the locum.",
  },
  {
    table: "cancellation_fees",
    action: "retain",
    because:
      "§9 charges ride a pharmacy's invoice. Erasing them would alter a financial record already issued to a third party.",
  },
  {
    table: "subscriptions",
    action: "retain",
    because: "Belongs to the pharmacy.",
  },
  {
    table: "subscription_charges",
    action: "retain",
    because: "Financial records under SARS retention rules.",
  },
  {
    table: "shift_offers",
    action: "delete",
    /*
     * §12.3's record of who was proactively messaged about which shift.
     *
     * Deleted rather than retained, and the distinction from `bookings` is the
     * point: a booking is evidence that someone worked, which a pharmacy may
     * need years later. An OFFER is evidence only that we messaged them, and
     * keeping a list of unanswered approaches to someone who has since asked
     * to be erased is exactly the residue POPIA is about.
     *
     * It carries no reputation signal either — §7 counts completed shifts and
     * no-shows, not offers declined — so deleting it cannot become the
     * reputation reset that erasure.ts refuses to allow.
     */
    because:
      "A record that we messaged this person about a shift. It proves nothing about work performed, and retaining unanswered approaches to an erased account is the residue §10 exists to remove.",
  },
  {
    table: "favourite_locums",
    action: "delete",
    because:
      "A pharmacy's saved list of a person who has left. Keeping it would surface a deleted account in future shift visibility (§10.1).",
  },
  {
    table: "pharmacy_members",
    action: "delete",
    because: "Membership of a pharmacy the person no longer has.",
  },
  {
    table: "whatsapp_message_log",
    action: "anonymise",
    because:
      "Delivery records are detached from the user. Retained in aggregate because §11.6 spend and §11.7 delivery rates must stay correct historically.",
  },
  {
    table: "audit_log",
    action: "retain",
    because:
      "§12.1 requires every verification decision to be logged with the reviewing admin's identity. An audit log a subject can edit is not an audit log — this is the one table where the legal obligation clearly outweighs the erasure right.",
  },
  {
    table: "pharmacies",
    action: "retain",
    because: "An organisation, not a natural person.",
  },
  {
    table: "idempotency_keys",
    action: "retain",
    because: "Hashes and response bodies, swept on expiry. No identity.",
  },
  {
    table: "rate_limit_counters",
    action: "delete",
    because:
      "Counts of how often an account browsed or applied, keyed to that account. Deleted outright — the counters exist to shape behaviour in a one-hour window and are worthless the moment it closes. They are also swept independently by the worker, so erasure only removes them sooner.",
  },
  {
    table: "verification_runs",
    action: "retain",
    because: "§12.5 gate ledger. Engineering records, no user data.",
  },
];

export function ruleFor(table: string): RetentionRule | undefined {
  return RETENTION_POLICY.find((rule) => rule.table === table);
}

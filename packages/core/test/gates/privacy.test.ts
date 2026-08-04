import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  EXPORTED_TABLES,
  RETENTION_POLICY,
  eraseSubject,
  exportSubjectData,
  isDomainError,
  isErased,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: privacy.popia
 *
 * §10 gives a data subject two rights this product had implemented neither of:
 * access and erasure. It holds SAPC certificates, ID documents, a GPS trace for
 * every shift worked, and message history — and until this gate there was no
 * way to get any of it out, or to have any of it removed.
 *
 * The tests split along the same line as the code. Export is judged on
 * completeness: a partial export is worse than none, because it tells someone
 * "this is what we hold" while omitting where they physically stood on
 * fourteen mornings. Erasure is judged on what it REFUSES to erase.
 */

const { db, client } = connect();
const JHB = { lng: 28.0473, lat: -26.2041 };

const createdUserIds: string[] = [];
const createdPharmacyIds: string[] = [];

interface Subject {
  locumId: string;
  managerId: string;
  pharmacyId: string;
  bookingId: string;
  email: string;
}

async function makeSubject(): Promise<Subject> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `priv-${tag}@test.invalid`;

  const [locum, manager] = await db
    .insert(s.users)
    .values([
      {
        role: "locum",
        email,
        fullName: "Thabo Mokoena",
        phone: "+27821234567",
        popiaConsentAt: new Date(),
        passwordHash: "argon2-placeholder",
      },
      { role: "manager", email: `priv-m-${tag}@test.invalid`, fullName: "Manager" },
    ])
    .returning({ id: s.users.id });
  createdUserIds.push(locum!.id, manager!.id);

  const [pharmacy] = await db
    .insert(s.pharmacies)
    .values({ name: `Priv ${tag}`, addressLine: "1 Rd", city: "Johannesburg", location: JHB })
    .returning({ id: s.pharmacies.id });
  createdPharmacyIds.push(pharmacy!.id);

  await db
    .insert(s.pharmacyMembers)
    .values({ pharmacyId: pharmacy!.id, userId: manager!.id, isPrimary: true });

  await db.insert(s.locumProfiles).values({
    userId: locum!.id,
    verification: "verified",
    baseLocation: JHB,
    sapcNumber: "P12345",
    completedShifts: 40,
    noShows: 3,
  });

  const endsAt = new Date(Date.now() - 24 * 3_600_000);
  const [shift] = await db
    .insert(s.shifts)
    .values({
      pharmacyId: pharmacy!.id,
      createdBy: manager!.id,
      startsAt: new Date(endsAt.getTime() - 8 * 3_600_000),
      endsAt,
      status: "completed",
      hourlyRateCents: 45_000,
      location: JHB,
    })
    .returning({ id: s.shifts.id });

  const [booking] = await db
    .insert(s.bookings)
    .values({ shiftId: shift!.id, locumId: locum!.id, status: "completed" })
    .returning({ id: s.bookings.id });

  // The invasive stuff: a GPS trace, a message, a document, a session.
  await db.insert(s.checkIns).values({
    bookingId: booking!.id,
    checkedInAt: new Date(endsAt.getTime() - 8 * 3_600_000),
    checkInLocation: JHB,
    checkInAccuracyM: 12,
  });
  await db.insert(s.messages).values({
    bookingId: booking!.id,
    senderId: locum!.id,
    body: "Running ten minutes late, traffic on the M1",
  });
  await db.insert(s.documents).values({
    userId: locum!.id,
    type: "sapc_certificate",
    storageKey: `docs/${tag}`,
    sizeBytes: 1024,
    detectedMimeType: "application/pdf",
    sha256: "a".repeat(64),
    scan: "clean",
  });
  await db.insert(s.whatsappMessageLog).values({
    twilioSid: `SMpriv${tag}`,
    userId: locum!.id,
    direction: "outbound",
    status: "delivered",
  });

  return {
    locumId: locum!.id,
    managerId: manager!.id,
    pharmacyId: pharmacy!.id,
    bookingId: booking!.id,
    email,
  };
}

afterEach(async () => {
  const users = createdUserIds.splice(0);
  const pharmacies = createdPharmacyIds.splice(0);
  if (users.length > 0) {
    await db.delete(s.messages).where(inArray(s.messages.senderId, users));
    await db.delete(s.documents).where(inArray(s.documents.userId, users));
    await db.delete(s.whatsappMessageLog).where(inArray(s.whatsappMessageLog.userId, users));
    await db.delete(s.auditLog).where(inArray(s.auditLog.actorId, users));
  }
  if (pharmacies.length > 0) {
    await db.delete(s.pharmacies).where(inArray(s.pharmacies.id, pharmacies));
  }
  if (users.length > 0) {
    await db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, users));
    await db.delete(s.users).where(inArray(s.users.id, users));
  }
});

afterAll(async () => {
  await client.end();
});

describe("GATE privacy.popia — the retention policy covers the schema", () => {
  it("has a decision recorded for every table in the database", () => {
    /*
     * The structural guarantee the whole gate rests on. A table added without
     * a retention decision is a table that silently survives erasure, and
     * nobody finds out until a regulator asks. Failing the build is the only
     * mechanism that reliably catches it.
     */
    const schemaDir = fileURLToPath(new URL("../../../db/src/schema/", import.meta.url));
    const tablesInSchema = new Set<string>();

    for (const file of readdirSync(schemaDir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(`${schemaDir}${file}`, "utf8");
      for (const match of source.matchAll(/pgTable\(\s*"([a-z_]+)"/g)) {
        tablesInSchema.add(match[1]!);
      }
    }

    const covered = new Set(RETENTION_POLICY.map((rule) => rule.table));
    const missing = [...tablesInSchema].filter((table) => !covered.has(table));

    expect(
      missing,
      `these tables have no retention decision — add one to RETENTION_POLICY: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("gives a reason for every decision", () => {
    // Unexplained retention is how "we keep it because we always have" becomes
    // policy. Every rule states its ground.
    for (const rule of RETENTION_POLICY) {
      expect(rule.because.length, `${rule.table} has no reason`).toBeGreaterThan(20);
    }
  });

  it("exports from every table that holds personal data", () => {
    /*
     * Anything the policy says must be deleted or anonymised holds personal
     * data by definition — so it must appear in the export. A table we are
     * willing to erase but not to disclose is an inconsistency the subject
     * would never be able to see.
     */
    const personal = RETENTION_POLICY.filter((r) => r.action !== "retain").map((r) => r.table);
    const exported = new Set(EXPORTED_TABLES);
    const undisclosed = personal.filter((table) => !exported.has(table));

    expect(
      undisclosed,
      `erased but never disclosed: ${undisclosed.join(", ")}`,
    ).toEqual([]);
  });
});

describe("GATE privacy.popia — right of access", () => {
  it("returns everything held, including the GPS trace", async () => {
    const subject = await makeSubject();
    const dump = await exportSubjectData(db, subject.locumId);

    expect(dump.account["email"]).toBe(subject.email);
    expect(dump.account["fullName"]).toBe("Thabo Mokoena");
    expect(dump.locumProfile).not.toBeNull();
    expect(dump.bookings).toHaveLength(1);
    expect(dump.documents).toHaveLength(1);
    expect(dump.messagesSent).toHaveLength(1);
    expect(dump.whatsappMessages).toHaveLength(1);

    /*
     * The one most likely to be forgotten, because it is reached through a
     * join rather than held directly — and the most invasive thing on the
     * list. An export omitting it would tell someone the platform holds far
     * less about them than it does.
     */
    expect(dump.attendance, "the GPS trace must be disclosed").toHaveLength(1);
    expect(dump.attendance[0]!["checkInAccuracyM"]).toBe(12);
  });

  it("never returns the password hash or MFA secret", async () => {
    /*
     * The likeliest moment for a suspicious export request is when the
     * requester is not the account holder. Returning credentials would turn a
     * routine data request into account takeover.
     */
    const subject = await makeSubject();
    const dump = await exportSubjectData(db, subject.locumId);
    const serialised = JSON.stringify(dump);

    expect(dump.account["hasPassword"]).toBe(true);
    expect(serialised).not.toContain("argon2-placeholder");
    expect(serialised).not.toMatch(/passwordHash|mfaSecret/);
  });

  it("does not reveal who rated the subject", async () => {
    /*
     * §7's anonymisation would be trivially defeated by a data request that
     * returns "who said what about you". The person with an access right here
     * is the ratee; the raters have their own.
     */
    const subject = await makeSubject();
    await db.insert(s.ratings).values({
      bookingId: subject.bookingId,
      raterId: subject.managerId,
      rateeId: subject.locumId,
      score: 2,
      comment: "Late twice",
    });

    const dump = await exportSubjectData(db, subject.locumId);
    expect(dump.ratingsReceived).toHaveLength(1);
    expect(dump.ratingsReceived[0]!["score"]).toBe(2);
    expect(
      JSON.stringify(dump.ratingsReceived),
      "the rater's identity must not be disclosed",
    ).not.toContain(subject.managerId);
  });

  it("refuses for an account that does not exist", async () => {
    const error = await exportSubjectData(
      db,
      "00000000-0000-0000-0000-000000000000",
    ).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe("SUBJECT_NOT_FOUND");
  });
});

describe("GATE privacy.popia — right to erasure", () => {
  it("removes the identity and the sensitive holdings", async () => {
    const subject = await makeSubject();
    const report = await eraseSubject(db, {
      subjectId: subject.locumId,
      requestedBy: subject.managerId,
    });

    const [user] = await db
      .select()
      .from(s.users)
      .where(eq(s.users.id, subject.locumId));

    expect(user!.fullName).toBe("[erased]");
    expect(user!.phone).toBeNull();
    expect(user!.passwordHash).toBeNull();
    expect(user!.mfaSecret).toBeNull();
    expect(user!.email).toMatch(/@erased\.invalid$/);
    expect(user!.erasedAt).not.toBeNull();

    // The documents are gone outright — no counterparty has a claim on an ID.
    const docs = await db
      .select()
      .from(s.documents)
      .where(eq(s.documents.userId, subject.locumId));
    expect(docs).toHaveLength(0);

    // The GPS trace is cleared.
    const [attendance] = await db
      .select()
      .from(s.checkIns)
      .where(eq(s.checkIns.bookingId, subject.bookingId));
    expect(attendance!.checkInLocation).toBeNull();
    expect(attendance!.checkInAccuracyM).toBeNull();

    // ...and the message body.
    const [message] = await db
      .select()
      .from(s.messages)
      .where(eq(s.messages.senderId, subject.locumId));
    expect(message!.body).not.toContain("M1");

    expect(await isErased(db, subject.locumId)).toBe(true);
    expect(report.affected.length).toBeGreaterThan(5);
  });

  it("does NOT erase the no-show history", async () => {
    /*
     * The sharpest interaction in this gate, and the one that looks like a
     * privacy feature working correctly.
     *
     * §7 exists so a record of no-shows means something. If erasure discarded
     * that record and re-registering is free, the locum with three no-shows
     * becomes a new locum with none — and every pharmacy trusting a tier has
     * been misled by a feature behaving exactly as documented.
     *
     * Once the identity is gone, two integers on a random uuid are not
     * personal information.
     */
    const subject = await makeSubject();
    await eraseSubject(db, { subjectId: subject.locumId, requestedBy: subject.managerId });

    const [profile] = await db
      .select()
      .from(s.locumProfiles)
      .where(eq(s.locumProfiles.userId, subject.locumId));

    expect(profile!.noShows, "erasure must not be a reputation reset").toBe(3);
    expect(profile!.completedShifts).toBe(40);
    // ...while everything identifying is gone.
    expect(profile!.baseLocation).toBeNull();
    expect(profile!.sapcNumber).toBeNull();
  });

  it("does NOT erase the pharmacy's record that a shift was covered", async () => {
    /*
     * A shift worked in March happened to both parties. The pharmacy needs it
     * for its own compliance, and it is not the locum's to remove.
     */
    const subject = await makeSubject();
    await eraseSubject(db, { subjectId: subject.locumId, requestedBy: subject.managerId });

    const [booking] = await db
      .select()
      .from(s.bookings)
      .where(eq(s.bookings.id, subject.bookingId));
    expect(booking).toBeDefined();
    expect(booking!.status).toBe("completed");

    // The attendance TIMES survive even though the coordinates did not.
    const [attendance] = await db
      .select()
      .from(s.checkIns)
      .where(eq(s.checkIns.bookingId, subject.bookingId));
    expect(attendance!.checkedInAt).not.toBeNull();
  });

  it("leaves the erased account unable to be signed into", async () => {
    const subject = await makeSubject();
    await eraseSubject(db, { subjectId: subject.locumId, requestedBy: subject.managerId });

    const [user] = await db.select().from(s.users).where(eq(s.users.id, subject.locumId));
    expect(user!.passwordHash).toBeNull();
    expect(user!.disabledAt).not.toBeNull();
    // §12.1 — the watermark invalidates any token issued before erasure.
    expect(user!.sessionsValidFrom.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses a second erasure rather than reporting success", async () => {
    // A repeat request usually means someone is hunting for data that is
    // already gone. Saying "done" sends them away satisfied and wrong.
    const subject = await makeSubject();
    await eraseSubject(db, { subjectId: subject.locumId, requestedBy: subject.managerId });

    const error = await eraseSubject(db, {
      subjectId: subject.locumId,
      requestedBy: subject.managerId,
    }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe("ALREADY_ERASED");
  });

  it("records that an erasure happened", async () => {
    // §12.1's audit log survives erasure by policy; this is the entry proving
    // the erasure itself was performed and by whom.
    const subject = await makeSubject();
    await eraseSubject(db, { subjectId: subject.locumId, requestedBy: subject.managerId });

    const entries = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.actorId, subject.managerId));

    expect(entries.some((e) => e.action === "privacy.erase")).toBe(true);
  });

  it("leaves nothing identifying behind in a fresh export", async () => {
    /*
     * The end-to-end check, and the one a regulator would actually run: erase,
     * then ask the system what it still holds.
     */
    const subject = await makeSubject();
    await eraseSubject(db, { subjectId: subject.locumId, requestedBy: subject.managerId });

    const dump = await exportSubjectData(db, subject.locumId);
    const serialised = JSON.stringify(dump);

    expect(serialised).not.toContain("Thabo Mokoena");
    expect(serialised).not.toContain("+27821234567");
    expect(serialised).not.toContain("P12345");
    expect(serialised).not.toContain(subject.email);
    expect(serialised).not.toContain("M1");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  DISINTERMEDIATION_RULES,
  detectDisintermediation,
  isDomainError,
  listFlaggedMessages,
  postMessage,
  readThread,
  THREAD_OPEN_AFTER_SHIFT_HOURS,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: messaging.disintermediation
 *
 * §15 is unusually explicit about this one: "G (harness) → X + human
 * labelling. The number does not exist until measured."
 *
 * So this file is deliberately two different kinds of test with two different
 * standards of proof, and conflating them would defeat the point.
 *
 *   1. **Mechanism.** Hard assertions. Every rule fires on something; the
 *      false positives §14 names by hand do not fire; a flagged message is
 *      still delivered; the thread gate refuses non-participants and closed
 *      threads. These are properties of the code and they either hold or they
 *      do not.
 *
 *   2. **Accuracy.** Reported, never asserted. The corpus labels were written
 *      by the same process that wrote the regexes, so a false-positive rate
 *      measured against them measures that process's internal consistency. It
 *      is printed so it can be watched for movement, and the gate stays open
 *      until `reviewed: true` appears in the corpus.
 *
 * A test that asserted "false-positive rate < 5%" against self-authored labels
 * would be the most misleading green check in this repository.
 */

const { db, client } = connect();

interface CorpusEntry {
  readonly id: string;
  readonly text: string;
  readonly label: "positive" | "negative";
  readonly reviewed: boolean;
  readonly note?: string;
}

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/disintermediation-corpus.json", import.meta.url)),
    "utf8",
  ),
) as { messages: CorpusEntry[] };

const JHB = { lng: 28.0473, lat: -26.2041 };
const createdUserIds: string[] = [];
const createdPharmacyIds: string[] = [];

interface Scenario {
  readonly managerId: string;
  readonly locumId: string;
  readonly outsiderId: string;
  readonly bookingId: string;
  readonly shiftEndsAt: Date;
}

async function makeScenario(options: { shiftEndsAt?: Date } = {}): Promise<Scenario> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const shiftEndsAt = options.shiftEndsAt ?? new Date(Date.now() - 3_600_000);

  const [manager, locum, outsider] = await db
    .insert(s.users)
    .values([
      { role: "manager", email: `dm-mgr-${tag}@test.invalid`, fullName: "Manager" },
      { role: "locum", email: `dm-loc-${tag}@test.invalid`, fullName: "Locum" },
      { role: "locum", email: `dm-out-${tag}@test.invalid`, fullName: "Outsider" },
    ])
    .returning({ id: s.users.id });
  createdUserIds.push(manager!.id, locum!.id, outsider!.id);

  const [pharmacy] = await db
    .insert(s.pharmacies)
    .values({
      name: `Thread Pharmacy ${tag}`,
      addressLine: "1 Road",
      city: "Johannesburg",
      location: JHB,
    })
    .returning({ id: s.pharmacies.id });
  createdPharmacyIds.push(pharmacy!.id);

  await db
    .insert(s.pharmacyMembers)
    .values({ pharmacyId: pharmacy!.id, userId: manager!.id, isPrimary: true });

  await db.insert(s.locumProfiles).values({
    userId: locum!.id,
    verification: "verified",
    baseLocation: JHB,
  });

  const [shift] = await db
    .insert(s.shifts)
    .values({
      pharmacyId: pharmacy!.id,
      createdBy: manager!.id,
      startsAt: new Date(shiftEndsAt.getTime() - 8 * 3_600_000),
      endsAt: shiftEndsAt,
      status: "filled",
      hourlyRateCents: 45_000,
      location: JHB,
    })
    .returning({ id: s.shifts.id });

  const [booking] = await db
    .insert(s.bookings)
    .values({ shiftId: shift!.id, locumId: locum!.id, status: "confirmed" })
    .returning({ id: s.bookings.id });

  return {
    managerId: manager!.id,
    locumId: locum!.id,
    outsiderId: outsider!.id,
    bookingId: booking!.id,
    shiftEndsAt,
  };
}

afterEach(async () => {
  const users = createdUserIds.splice(0);
  const pharmacies = createdPharmacyIds.splice(0);
  if (users.length > 0) {
    await db.delete(s.messages).where(inArray(s.messages.senderId, users));
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

describe("GATE messaging.disintermediation — §6 detection (mechanism)", () => {
  it("flags a shared South African mobile number in every plausible format", () => {
    for (const body of [
      "call me on 082 555 1234",
      "0824567890",
      "+27 82 555 9911",
      "27715558080",
      "(082) 555 6677",
      "083-555-0142",
    ]) {
      expect(detectDisintermediation(body).flagged, body).toBe(true);
    }
  });

  it("does NOT flag the numbers this product is full of", () => {
    /*
     * The reason SA_MOBILE pins the shape rather than looking for "a long run
     * of digits". Rates, times, script counts, practice numbers and invoice
     * numbers are the bulk of what these two people talk about, and a detector
     * that flags them produces a review queue nobody reads.
     */
    for (const body of [
      "Rate is R450 per hour, 8 hour shift",
      "Shift is 08:00 to 17:00 with a 30 min break",
      "We dispensed 1240 scripts last month",
      "Practice number 0453219 if SAPC ask",
      "Invoice 20260801 should be in your portal",
      "Stock code 5501234 is the one that's short",
      "R 1 250 for the day, is that ok",
    ]) {
      expect(detectDisintermediation(body).flagged, body).toBe(false);
    }
  });

  it("does NOT flag the false positives §14 names by hand", () => {
    // Quoted from §14. These are the spec's own examples of what must not
    // trip, and they are assertions rather than corpus statistics.
    for (const body of [
      "call the pharmacy on Monday and ask for Sipho",
      "the manager will call you about the roster",
      "Please call the pharmacy if you're running late",
      "Someone from the pharmacy will call you tomorrow",
    ]) {
      expect(detectDisintermediation(body).flagged, body).toBe(false);
    }
  });

  it("flags the true positives §14 names by hand", () => {
    for (const body of [
      "call me on 082 555 1234",
      "lets sort this directly, the app takes forever",
      "Rather do it off the app, less admin",
    ]) {
      expect(detectDisintermediation(body).flagged, body).toBe(true);
    }
  });

  it("does not flag someone explicitly staying inside the platform", () => {
    /*
     * §10.1's success case, and it trips the phrase rules on its wording
     * alone. Someone saying "WhatsApp me on the app number, not my personal
     * one" is doing exactly what the product asks; flagging them teaches a
     * reviewer that the queue is noise.
     */
    for (const body of [
      "Message me here if anything changes",
      "Call me through the app if you get lost",
      "WhatsApp me on the app number, not my personal one",
      "Contact me via the platform please",
    ]) {
      expect(detectDisintermediation(body).flagged, body).toBe(false);
    }
  });

  it("names the rule that fired, so a reviewer can judge the flag", () => {
    // A confidence score gives a reviewer nothing to disagree with. A rule
    // name they can read is what makes the queue workable.
    const result = detectDisintermediation("my cell is 0825551234, call me");
    expect(result.reason).toContain("sa_mobile_number");
    expect(result.reason!.length).toBeLessThanOrEqual(120); // flag_reason width
  });

  it("every declared rule fires on at least one corpus entry", () => {
    /*
     * Catches the rule that was written, subtly broken, and never matched
     * anything again — which looks identical to a rule that is simply never
     * triggered, and reports the same clean false-positive rate.
     */
    const fired = new Set<string>();
    for (const entry of corpus.messages) {
      for (const signal of detectDisintermediation(entry.text).signals) {
        fired.add(signal.rule);
      }
    }
    expect([...DISINTERMEDIATION_RULES].filter((rule) => !fired.has(rule))).toEqual([]);
  });
});

describe("GATE messaging.disintermediation — §14 corpus (measured, not asserted)", () => {
  it("has at least the 200 messages §14 requires, spanning both labels", () => {
    expect(corpus.messages.length).toBeGreaterThanOrEqual(200);
    expect(corpus.messages.filter((m) => m.label === "positive").length).toBeGreaterThan(20);
    expect(corpus.messages.filter((m) => m.label === "negative").length).toBeGreaterThan(100);
  });

  it("reports accuracy without treating it as a gate", () => {
    let truePositive = 0;
    let falsePositive = 0;
    let trueNegative = 0;
    let falseNegative = 0;
    const misses: string[] = [];

    for (const entry of corpus.messages) {
      const flagged = detectDisintermediation(entry.text).flagged;
      if (entry.label === "positive") {
        if (flagged) truePositive += 1;
        else {
          falseNegative += 1;
          misses.push(entry.id);
        }
      } else if (flagged) {
        falsePositive += 1;
        misses.push(entry.id);
      } else {
        trueNegative += 1;
      }
    }

    const reviewed = corpus.messages.filter((m) => m.reviewed).length;
    const falsePositiveRate = falsePositive / (falsePositive + trueNegative);

    console.log(
      [
        "",
        "  §14 disintermediation corpus — PROVISIONAL",
        `    corpus:              ${corpus.messages.length} messages, ${reviewed} human-reviewed`,
        `    true positives:      ${truePositive}`,
        `    false positives:     ${falsePositive}`,
        `    true negatives:      ${trueNegative}`,
        `    false negatives:     ${falseNegative}`,
        `    false-positive rate: ${(falsePositiveRate * 100).toFixed(2)}%`,
        `    disagreements:       ${misses.join(", ") || "none"}`,
        "",
        reviewed === corpus.messages.length
          ? "    Labels are human-reviewed. This number is real."
          : "    Labels are NOT human-reviewed. This number describes the",
        reviewed === corpus.messages.length
          ? ""
          : "    consistency of whatever wrote the labels, not the accuracy of",
        reviewed === corpus.messages.length ? "" : "    the detector. §15 keeps the gate open.",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );

    /*
     * The only assertion here is that the measurement ran. Asserting a
     * threshold against self-authored labels is how a project convinces itself
     * it has measured something.
     */
    expect(truePositive + falsePositive + trueNegative + falseNegative).toBe(
      corpus.messages.length,
    );
  });

  it("is honest about being an unreviewed draft", () => {
    /*
     * This test *passes* while the corpus is unreviewed — it is not a nag.
     * What it enforces is that the corpus cannot quietly become authoritative:
     * the day someone sets reviewed:true on part of it, the assertion below
     * changes meaning, and the gate in gates.json must be revisited
     * deliberately rather than drifting into looking closed.
     */
    const reviewed = corpus.messages.filter((m) => m.reviewed).length;
    if (reviewed === 0) {
      expect(corpus.messages.every((m) => m.reviewed === false)).toBe(true);
      return;
    }
    expect(
      reviewed,
      "partial review: finish labelling before deriving a rate from this corpus",
    ).toBe(corpus.messages.length);
  });
});

describe("GATE messaging.disintermediation — §6 thread gate", () => {
  it("stores the flag and the rule, and delivers the message anyway", async () => {
    /*
     * The central product decision. §14: the false-positive rate is unknown
     * until a human labels the corpus. Blocking on an unvalidated regex means
     * silently breaking a conversation between two people trying to staff a
     * pharmacy tomorrow morning — a much worse outcome than a flag someone
     * reviews later.
     */
    const scenario = await makeScenario();
    const flagged: string[] = [];

    const posted = await postMessage(
      db,
      { onFlagged: (context) => flagged.push(...context.rules) },
      {
        bookingId: scenario.bookingId,
        senderId: scenario.locumId,
        body: "easier if you just call me on 082 555 1234",
      },
    );

    expect(posted.flagged).toBe(true);
    expect(posted.flagReason).toContain("sa_mobile_number");
    expect(flagged).toContain("sa_mobile_number");

    const [row] = await db
      .select({
        body: s.messages.body,
        flag: s.messages.flaggedDisintermediation,
        reason: s.messages.flagReason,
      })
      .from(s.messages)
      .where(eq(s.messages.id, posted.id));

    expect(row!.flag).toBe(true);
    expect(row!.reason).toContain("sa_mobile_number");
    // Stored verbatim: a reviewer adjudicating a flag has to see what was
    // actually said, and a recipient must not receive a mangled message.
    expect(row!.body).toBe("easier if you just call me on 082 555 1234");

    // Delivered — the recipient's view contains it.
    const thread = await readThread(db, {
      bookingId: scenario.bookingId,
      readerId: scenario.managerId,
    });
    expect(thread.map((m) => m.body)).toContain(
      "easier if you just call me on 082 555 1234",
    );
  });

  it("does not leak the flag to the participants", async () => {
    /*
     * If a sender can see which phrasings trip the detector, the review queue
     * becomes a tutorial for evading it. The flags belong to the admin query.
     */
    const scenario = await makeScenario();
    await postMessage(db, {}, {
      bookingId: scenario.bookingId,
      senderId: scenario.locumId,
      body: "my number is 0731234567",
    });

    const thread = await readThread(db, {
      bookingId: scenario.bookingId,
      readerId: scenario.locumId,
    });
    expect(thread).toHaveLength(1);
    expect(Object.keys(thread[0]!)).toEqual(["id", "senderId", "body", "createdAt"]);
  });

  it("surfaces the flag in the admin queue", async () => {
    const scenario = await makeScenario();
    const posted = await postMessage(db, {}, {
      bookingId: scenario.bookingId,
      senderId: scenario.locumId,
      body: "lets just sort this directly",
    });

    const queue = await listFlaggedMessages(db);
    expect(queue.map((m) => m.id)).toContain(posted.id);
  });

  it("refuses a sender who is neither the locum nor a member of the pharmacy", async () => {
    const scenario = await makeScenario();
    const error = await postMessage(db, {}, {
      bookingId: scenario.bookingId,
      senderId: scenario.outsiderId,
      body: "hello",
    }).catch((e: unknown) => e);

    expect(isDomainError(error) && error.code).toBe("NOT_BOOKING_PARTICIPANT");
  });

  it("refuses to open a thread for a shift that ended long ago", async () => {
    /*
     * §6 is time-gated messaging, and the gate is the point: a booking creates
     * a reason for two people to talk, not a permanent channel between them.
     * An unbounded thread is one someone can be harassed through months after
     * a shift they worked once.
     */
    const endedLongAgo = new Date(
      Date.now() - (THREAD_OPEN_AFTER_SHIFT_HOURS + 1) * 3_600_000,
    );
    const scenario = await makeScenario({ shiftEndsAt: endedLongAgo });

    const error = await postMessage(db, {}, {
      bookingId: scenario.bookingId,
      senderId: scenario.locumId,
      body: "hello",
    }).catch((e: unknown) => e);

    expect(isDomainError(error) && error.code).toBe("THREAD_CLOSED");
  });

  it("keeps the thread open in the window right after the shift", async () => {
    // The dispute window. §7's `disputed` booking state assumes the two people
    // involved can still talk about what happened.
    const endedRecently = new Date(
      Date.now() - (THREAD_OPEN_AFTER_SHIFT_HOURS - 1) * 3_600_000,
    );
    const scenario = await makeScenario({ shiftEndsAt: endedRecently });

    const posted = await postMessage(db, {}, {
      bookingId: scenario.bookingId,
      senderId: scenario.managerId,
      body: "Thanks again for covering yesterday",
    });
    expect(posted.flagged).toBe(false);
  });

  it("lets a manager and locum talk before the booking is confirmed", async () => {
    /*
     * `requested` is inside the gate on purpose. A manager needs to ask a
     * question before confirming, and forcing confirmation first pushes
     * exactly that conversation onto WhatsApp — the behaviour §10.1 exists to
     * replace.
     */
    const scenario = await makeScenario();
    await db
      .update(s.bookings)
      .set({ status: "requested" })
      .where(eq(s.bookings.id, scenario.bookingId));

    const posted = await postMessage(db, {}, {
      bookingId: scenario.bookingId,
      senderId: scenario.managerId,
      body: "Have you worked with Unisolv before?",
    });
    expect(posted.flagged).toBe(false);
  });
});

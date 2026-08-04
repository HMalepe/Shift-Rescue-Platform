import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  checkIn,
  checkOut,
  confirmBooking,
  getAttendance,
} from "../../src/index";
import {
  connect,
  createContendedShift,
  cleanupScenario,
  type ShiftScenario,
} from "../helpers/fixtures";

/**
 * GATE: product.attendance
 *
 * §8 — opt-in check-in/check-out. The output is the hours-worked record a
 * pharmacy hands to its own payroll (§10.0); nothing here computes pay.
 *
 * The assertions that matter are about EVIDENCE quality: the distance must be
 * computed by the server from the pharmacy's stored location, and a spoofing
 * signal must survive rather than being clearable by the person it describes.
 */

const { db, client } = connect();

/**
 * The fixture pharmacy sits at Johannesburg CBD (28.0473, -26.2041).
 * ~40 m away — a plausible "at the counter" reading.
 */
const AT_THE_COUNTER = { lng: 28.0477, lat: -26.2041 };
/** Sandton, ~11 km north — plausible only if they are not at work. */
const SOMEWHERE_ELSE = { lng: 28.0567, lat: -26.1076 };

afterAll(async () => {
  await client.end();
});

/** A scenario with one confirmed booking, ready to check in against. */
async function confirmedBooking(): Promise<{
  scenario: ShiftScenario;
  bookingId: string;
  locumId: string;
}> {
  const scenario = await createContendedShift(db, 2);

  // The fixture shift starts in 48h; check-in requires the shift to be under
  // way, so pull it back to now.
  await db
    .update(s.shifts)
    .set({
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 8 * 3_600_000),
    })
    .where(eq(s.shifts.id, scenario.shiftId));

  await confirmBooking(db, {
    bookingId: scenario.bookingIds[0]!,
    actorId: scenario.managerId,
  });

  return {
    scenario,
    bookingId: scenario.bookingIds[0]!,
    locumId: scenario.locumIds[0]!,
  };
}

describe("GATE product.attendance — check-in", () => {
  it("records a check-in with a server-computed distance", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      const record = await checkIn(db, {
        bookingId,
        actorId: locumId,
        location: AT_THE_COUNTER,
        accuracyM: 12,
        mockLocationDetected: false,
      });

      expect(record.checkedInAt).toBeInstanceOf(Date);
      // ~40 m from the pharmacy, computed by PostGIS on the geography type.
      expect(record.checkInDistanceM).toBeGreaterThanOrEqual(0);
      expect(record.checkInDistanceM).toBeLessThan(200);
      expect(record.minutesWorked).toBeNull();
    } finally {
      await db.delete(s.checkIns).where(eq(s.checkIns.bookingId, bookingId));
      await cleanupScenario(db, scenario);
    }
  });

  it("computes a large distance when the locum is nowhere near the pharmacy", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      const record = await checkIn(db, {
        bookingId,
        actorId: locumId,
        location: SOMEWHERE_ELSE,
      });

      /*
       * The check-in is ACCEPTED and flagged by distance rather than refused.
       * §8 keeps these as signals: a hard block would strand a pharmacist whose
       * phone has poor GPS indoors, which is common in a dispensary.
       */
      expect(record.checkedInAt).toBeInstanceOf(Date);
      expect(record.checkInDistanceM).toBeGreaterThan(9_000);
    } finally {
      await db.delete(s.checkIns).where(eq(s.checkIns.bookingId, bookingId));
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses a locum checking in against someone else's booking", async () => {
    const { scenario, bookingId } = await confirmedBooking();
    try {
      // locumIds[1] applied for the same shift but was not confirmed.
      await expect(
        checkIn(db, {
          bookingId,
          actorId: scenario.locumIds[1]!,
          location: AT_THE_COUNTER,
        }),
      ).rejects.toMatchObject({ code: "NOT_BOOKING_OWNER" });
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses a check-in against an unconfirmed booking", async () => {
    const scenario = await createContendedShift(db, 2);
    try {
      await expect(
        checkIn(db, {
          bookingId: scenario.bookingIds[0]!,
          actorId: scenario.locumIds[0]!,
          location: AT_THE_COUNTER,
        }),
      ).rejects.toMatchObject({ code: "BOOKING_NOT_CONFIRMED" });
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses a check-in long before the shift starts", async () => {
    const scenario = await createContendedShift(db, 2);
    try {
      await confirmBooking(db, {
        bookingId: scenario.bookingIds[0]!,
        actorId: scenario.managerId,
      });

      // Fixture shift starts in 48h, well outside the 2h grace.
      await expect(
        checkIn(db, {
          bookingId: scenario.bookingIds[0]!,
          actorId: scenario.locumIds[0]!,
          location: AT_THE_COUNTER,
        }),
      ).rejects.toMatchObject({ code: "CHECK_IN_TOO_EARLY" });
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("is idempotent — a double tap does not produce two check-ins", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      await checkIn(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER });

      // The second tap is refused with a clear domain error, not a raw
      // constraint violation.
      await expect(
        checkIn(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER }),
      ).rejects.toMatchObject({ code: "ALREADY_CHECKED_IN" });

      const rows = await db
        .select({ id: s.checkIns.id })
        .from(s.checkIns)
        .where(eq(s.checkIns.bookingId, bookingId));
      expect(rows).toHaveLength(1);
    } finally {
      await db.delete(s.checkIns).where(eq(s.checkIns.bookingId, bookingId));
      await cleanupScenario(db, scenario);
    }
  });
});

describe("GATE product.attendance — check-out and the payroll record", () => {
  it("produces an hours-worked record (§10.0)", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      await checkIn(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER });

      // Backdate the check-in so a measurable duration exists without sleeping.
      await db
        .update(s.checkIns)
        .set({ checkedInAt: new Date(Date.now() - 6 * 3_600_000) })
        .where(eq(s.checkIns.bookingId, bookingId));

      const record = await checkOut(db, {
        bookingId,
        actorId: locumId,
        location: AT_THE_COUNTER,
      });

      expect(record.checkedOutAt).toBeInstanceOf(Date);
      // ~6 hours. This number is the entire deliverable to payroll — the
      // platform never turns it into money (§10.0).
      expect(record.minutesWorked).toBeGreaterThanOrEqual(355);
      expect(record.minutesWorked).toBeLessThanOrEqual(365);
    } finally {
      await db.delete(s.checkIns).where(eq(s.checkIns.bookingId, bookingId));
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses a check-out with no check-in", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      await expect(
        checkOut(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER }),
      ).rejects.toMatchObject({ code: "NOT_CHECKED_IN" });
    } finally {
      await cleanupScenario(db, scenario);
    }
  });

  it("refuses a second check-out", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      await checkIn(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER });
      await checkOut(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER });

      await expect(
        checkOut(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER }),
      ).rejects.toMatchObject({ code: "ALREADY_CHECKED_OUT" });
    } finally {
      await db.delete(s.checkIns).where(eq(s.checkIns.bookingId, bookingId));
      await cleanupScenario(db, scenario);
    }
  });

  it("records check-out distance separately from check-in", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      await checkIn(db, { bookingId, actorId: locumId, location: AT_THE_COUNTER });
      const record = await checkOut(db, {
        bookingId,
        actorId: locumId,
        // Left early and checked out from Sandton — precisely the case an
        // hours-worked record needs to make visible.
        location: SOMEWHERE_ELSE,
      });

      expect(record.checkInDistanceM).toBeLessThan(200);
      expect(record.checkOutDistanceM).toBeGreaterThan(9_000);
    } finally {
      await db.delete(s.checkIns).where(eq(s.checkIns.bookingId, bookingId));
      await cleanupScenario(db, scenario);
    }
  });

  it("a clean check-out cannot clear a spoof flag raised at check-in", async () => {
    const { scenario, bookingId, locumId } = await confirmedBooking();
    try {
      await checkIn(db, {
        bookingId,
        actorId: locumId,
        location: AT_THE_COUNTER,
        mockLocationDetected: true,
      });

      const record = await checkOut(db, {
        bookingId,
        actorId: locumId,
        location: AT_THE_COUNTER,
        mockLocationDetected: false,
      });

      /*
       * The flag survives. Letting a clean check-out overwrite a suspicious
       * check-in would hand a trivial bypass to exactly the person the signal
       * is about — spoof the arrival, then check out honestly.
       */
      expect(record.mockLocationDetected).toBe(true);
    } finally {
      await db.delete(s.checkIns).where(eq(s.checkIns.bookingId, bookingId));
      await cleanupScenario(db, scenario);
    }
  });

  it("getAttendance returns undefined when nothing was recorded (§8 opt-in)", async () => {
    const { scenario, bookingId } = await confirmedBooking();
    try {
      // A shift can complete with no attendance record at all — check-in is
      // opt-in, and a booking without one is not an error.
      expect(await getAttendance(db, bookingId)).toBeUndefined();
    } finally {
      await cleanupScenario(db, scenario);
    }
  });
});

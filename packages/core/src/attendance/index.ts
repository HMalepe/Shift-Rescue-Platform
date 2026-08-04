import { eq, sql } from "drizzle-orm";
import {
  bookings,
  checkIns,
  pharmacies,
  shifts,
  type Database,
  type LngLat,
} from "@locum/db";
import { DomainError } from "../errors";

/**
 * §8 — opt-in check-in / check-out.
 *
 * What this produces is an hours-worked record a pharmacy hands to its own
 * payroll. That is the whole scope: §10.0 draws a hard line that the platform
 * never holds, routes or takes a cut of locum wages, so nothing here computes
 * pay. It records when someone arrived and left, and how far from the
 * dispensary they were when they said so.
 *
 * Two principles run through the file:
 *
 *   1. The client supplies a coordinate; the SERVER computes the distance.
 *      A distance reported by the device is a number the device chose.
 *
 *   2. Anti-spoofing signals are recorded, never enforced. §8 treats them as
 *      signals precisely because a false positive that voids a real
 *      pharmacist's shift record is worse than a missed spoof — the manager
 *      sees a flag and decides.
 */

export interface CheckInInput {
  readonly bookingId: string;
  /** Must be the locum the booking belongs to. */
  readonly actorId: string;
  readonly location: LngLat;
  /** GPS accuracy radius in metres, as reported by the device. */
  readonly accuracyM?: number;
  /**
   * §16 — Android's `Location.isFromMockProvider()`. There is no browser
   * equivalent, which is why §16 rules an emulator insufficient and requires a
   * physical device to close that gate. Undefined means "the client could not
   * tell us", which is different from false.
   */
  readonly mockLocationDetected?: boolean;
  readonly deviceSignals?: Record<string, unknown>;
}

export interface CheckOutInput {
  readonly bookingId: string;
  readonly actorId: string;
  readonly location: LngLat;
  readonly accuracyM?: number;
  readonly mockLocationDetected?: boolean;
  readonly deviceSignals?: Record<string, unknown>;
}

export interface AttendanceRecord {
  readonly bookingId: string;
  readonly checkedInAt: Date | null;
  readonly checkedOutAt: Date | null;
  readonly checkInDistanceM: number | null;
  readonly checkOutDistanceM: number | null;
  readonly mockLocationDetected: boolean | null;
  /** Null until both ends are recorded. */
  readonly minutesWorked: number | null;
}

/**
 * How early a locum may check in before the shift starts.
 *
 * Someone arriving 20 minutes early to hand over is normal; someone checking
 * in the night before is either confused or gaming the record. This is
 * deliberately generous — the cost of refusing a legitimate early arrival is a
 * pharmacist standing at a counter unable to start.
 */
const EARLY_CHECK_IN_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * How long after the shift ends a check-in is still plausible.
 *
 * Past this the record is almost certainly being reconstructed after the fact,
 * which is exactly what an attendance record exists to prevent.
 */
const LATE_CHECK_IN_GRACE_MS = 12 * 60 * 60 * 1000;

interface BookingContext {
  readonly bookingId: string;
  readonly bookingStatus: string;
  readonly locumId: string;
  readonly shiftStartsAt: Date;
  readonly shiftEndsAt: Date;
  readonly pharmacyLocation: string;
}

async function loadBookingContext(
  db: Database,
  bookingId: string,
): Promise<BookingContext | undefined> {
  const [row] = await db
    .select({
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      locumId: bookings.locumId,
      shiftStartsAt: shifts.startsAt,
      shiftEndsAt: shifts.endsAt,
      // Kept as the raw geography so the distance is computed in Postgres.
      pharmacyLocation: sql<string>`${pharmacies.location}::text`,
    })
    .from(bookings)
    .innerJoin(shifts, eq(shifts.id, bookings.shiftId))
    .innerJoin(pharmacies, eq(pharmacies.id, shifts.pharmacyId))
    .where(eq(bookings.id, bookingId))
    .limit(1);

  return row as BookingContext | undefined;
}

/**
 * Distance in metres between a claimed coordinate and the pharmacy.
 *
 * Computed by PostGIS on the `geography` type, so the answer is metres on the
 * spheroid rather than degrees — see the note on geographyPoint for why the
 * column is geography and not geometry.
 */
async function distanceToPharmacy(
  db: Database,
  pharmacyLocationWkb: string,
  claimed: LngLat,
): Promise<number> {
  const rows = await db.execute<{ metres: number }>(sql`
    SELECT ST_Distance(
      ${pharmacyLocationWkb}::geography,
      ST_SetSRID(ST_MakePoint(${claimed.lng}, ${claimed.lat}), 4326)::geography
    )::int AS metres
  `);
  return (rows as unknown as { metres: number }[])[0]?.metres ?? 0;
}

function assertActorOwnsBooking(context: BookingContext, actorId: string): void {
  /*
   * Only the booked locum may record their own attendance.
   *
   * A manager checking someone in would defeat the point: the record exists so
   * both sides can rely on it, and one that either side can author alone is
   * just an assertion. Disputes (§7) are resolved against this record.
   */
  if (context.locumId !== actorId) {
    throw new DomainError(
      "NOT_BOOKING_OWNER",
      "You can only record attendance for your own booking",
      { bookingId: context.bookingId },
    );
  }
}

export async function checkIn(
  db: Database,
  input: CheckInInput,
): Promise<AttendanceRecord> {
  const context = await loadBookingContext(db, input.bookingId);
  if (!context) {
    throw new DomainError("BOOKING_NOT_FOUND", "Booking does not exist", {
      bookingId: input.bookingId,
    });
  }

  assertActorOwnsBooking(context, input.actorId);

  if (context.bookingStatus !== "confirmed") {
    throw new DomainError(
      "BOOKING_NOT_CONFIRMED",
      `Cannot check in against a booking in state '${context.bookingStatus}'`,
      { bookingId: context.bookingId, status: context.bookingStatus },
    );
  }

  const now = Date.now();
  if (now < context.shiftStartsAt.getTime() - EARLY_CHECK_IN_GRACE_MS) {
    throw new DomainError(
      "CHECK_IN_TOO_EARLY",
      "This shift has not started yet",
      { startsAt: context.shiftStartsAt },
    );
  }
  if (now > context.shiftEndsAt.getTime() + LATE_CHECK_IN_GRACE_MS) {
    throw new DomainError(
      "CHECK_IN_TOO_LATE",
      "This shift ended too long ago to check in",
      { endsAt: context.shiftEndsAt },
    );
  }

  const existing = await getAttendance(db, input.bookingId);
  if (existing?.checkedInAt) {
    throw new DomainError("ALREADY_CHECKED_IN", "You have already checked in", {
      bookingId: input.bookingId,
      checkedInAt: existing.checkedInAt,
    });
  }

  const distanceM = await distanceToPharmacy(
    db,
    context.pharmacyLocation,
    input.location,
  );

  const checkedInAt = new Date();

  /*
   * ON CONFLICT rather than a check-then-insert. `check_ins` has a unique
   * index on booking_id, and a locum double-tapping on a poor connection —
   * the normal condition at a dispensary door — would otherwise produce a raw
   * constraint violation instead of the idempotent success their first tap
   * already earned.
   */
  await db
    .insert(checkIns)
    .values({
      bookingId: input.bookingId,
      checkedInAt,
      checkInLocation: input.location,
      checkInDistanceM: distanceM,
      ...(input.accuracyM !== undefined && { checkInAccuracyM: input.accuracyM }),
      ...(input.mockLocationDetected !== undefined && {
        mockLocationDetected: input.mockLocationDetected,
      }),
      ...(input.deviceSignals !== undefined && { deviceSignals: input.deviceSignals }),
    })
    .onConflictDoNothing({ target: checkIns.bookingId });

  const record = await getAttendance(db, input.bookingId);
  return record!;
}

export async function checkOut(
  db: Database,
  input: CheckOutInput,
): Promise<AttendanceRecord> {
  const context = await loadBookingContext(db, input.bookingId);
  if (!context) {
    throw new DomainError("BOOKING_NOT_FOUND", "Booking does not exist", {
      bookingId: input.bookingId,
    });
  }

  assertActorOwnsBooking(context, input.actorId);

  const existing = await getAttendance(db, input.bookingId);

  if (!existing?.checkedInAt) {
    throw new DomainError(
      "NOT_CHECKED_IN",
      "You must check in before checking out",
      { bookingId: input.bookingId },
    );
  }

  if (existing.checkedOutAt) {
    throw new DomainError(
      "ALREADY_CHECKED_OUT",
      "You have already checked out",
      { bookingId: input.bookingId, checkedOutAt: existing.checkedOutAt },
    );
  }

  const distanceM = await distanceToPharmacy(
    db,
    context.pharmacyLocation,
    input.location,
  );

  const checkedOutAt = new Date();

  await db
    .update(checkIns)
    .set({
      checkedOutAt,
      checkOutLocation: input.location,
      checkOutDistanceM: distanceM,
      ...(input.accuracyM !== undefined && { checkOutAccuracyM: input.accuracyM }),
      /*
       * A mock-location flag at EITHER end taints the record, so this is OR-ed
       * with whatever check-in recorded rather than overwriting it. Letting a
       * clean check-out clear a suspicious check-in would hand an easy bypass
       * to exactly the person the signal is about.
       */
      ...(input.mockLocationDetected === true && { mockLocationDetected: true }),
      ...(input.deviceSignals !== undefined && {
        deviceSignals: input.deviceSignals,
      }),
    })
    .where(eq(checkIns.bookingId, input.bookingId));

  const record = await getAttendance(db, input.bookingId);
  return record!;
}

export async function getAttendance(
  db: Database,
  bookingId: string,
): Promise<AttendanceRecord | undefined> {
  const [row] = await db
    .select({
      bookingId: checkIns.bookingId,
      checkedInAt: checkIns.checkedInAt,
      checkedOutAt: checkIns.checkedOutAt,
      checkInDistanceM: checkIns.checkInDistanceM,
      checkOutDistanceM: checkIns.checkOutDistanceM,
      mockLocationDetected: checkIns.mockLocationDetected,
    })
    .from(checkIns)
    .where(eq(checkIns.bookingId, bookingId))
    .limit(1);

  if (!row) return undefined;

  return {
    ...row,
    minutesWorked:
      row.checkedInAt && row.checkedOutAt
        ? Math.round(
            (row.checkedOutAt.getTime() - row.checkedInAt.getTime()) / 60_000,
          )
        : null,
  };
}

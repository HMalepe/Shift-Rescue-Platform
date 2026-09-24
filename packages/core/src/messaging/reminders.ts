import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { bookings, pharmacies, shifts, type Database } from "@locum/db";
import { sendWhatsAppMessage, type DashboardNotifyDeps, type SendOutcome } from "./send";
import { formatShiftStart } from "./templates";

/**
 * shift_starting_soon — once per confirmed booking, inside its lead window.
 *
 * Paged and ordered oldest-shift-first, same reasoning as
 * `rolloverDuePeriods` in the billing module: an unordered snapshot capped at
 * `limit` risks silently dropping whichever bookings didn't make the cut on a
 * backlog morning. Here the loop terminates because every booking it touches
 * gets `reminderSentAt` stamped — sent, suppressed or failed, it leaves the
 * WHERE clause's match set either way, so a bigger-than-`limit` backlog still
 * drains fully in one call.
 *
 * Deliberately fire-once, not retried on failure: this is a best-effort
 * reminder, not a transactional message like a booking confirmation. Retrying
 * a failed send every 5 minutes for the whole lead window would turn one
 * transient Twilio error into a burst of duplicate reminders the moment it
 * recovers.
 */
export async function remindUpcomingShifts(
  db: Database,
  deps: DashboardNotifyDeps,
  opts: {
    readonly limit?: number;
    readonly leadMinutes?: number;
    readonly now?: () => Date;
  } = {},
): Promise<ReadonlyArray<{ readonly bookingId: string; readonly outcome: SendOutcome }>> {
  const now = opts.now?.() ?? new Date();
  const leadMinutes = opts.leadMinutes ?? 60;
  const limit = opts.limit ?? 200;
  const leadCutoff = new Date(now.getTime() + leadMinutes * 60_000);

  const results: Array<{ bookingId: string; outcome: SendOutcome }> = [];
  for (;;) {
    const due = await db
      .select({
        bookingId: bookings.id,
        locumId: bookings.locumId,
        shiftId: shifts.id,
        pharmacyName: pharmacies.name,
        startsAt: shifts.startsAt,
      })
      .from(bookings)
      .innerJoin(shifts, eq(shifts.id, bookings.shiftId))
      .innerJoin(pharmacies, eq(pharmacies.id, shifts.pharmacyId))
      .where(
        and(
          eq(bookings.status, "confirmed"),
          isNull(bookings.reminderSentAt),
          gte(shifts.startsAt, now),
          lte(shifts.startsAt, leadCutoff),
        ),
      )
      .orderBy(asc(shifts.startsAt))
      .limit(limit);

    if (due.length === 0) break;

    for (const booking of due) {
      const outcome = await sendWhatsAppMessage(db, deps, {
        type: "shift_starting_soon",
        userId: booking.locumId,
        variables: [
          booking.pharmacyName,
          formatShiftStart(booking.startsAt),
          `${deps.dashboardBaseUrl}/shifts/${booking.shiftId}`,
        ],
      });

      await db
        .update(bookings)
        .set({ reminderSentAt: now })
        .where(eq(bookings.id, booking.bookingId));

      results.push({ bookingId: booking.bookingId, outcome });
    }

    if (due.length < limit) break;
  }
  return results;
}

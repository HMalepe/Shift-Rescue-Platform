/**
 * Post-run invariant check.
 *
 * k6 measures latency and error rates. It cannot answer the question the
 * §12.3 gate actually asks — "did the row locking hold?" — because that is a
 * property of the database after the run, not of any single HTTP response.
 *
 * A load test that reported only p95 and a 0% error rate would pass happily
 * while two locums were confirmed against the same shift, which is the exact
 * failure the gate exists to catch. So this runs after k6 and exits non-zero
 * if the invariant was violated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { MAX_TOTAL_PER_SHIFT } from "@locum/core";
import {
  bookings,
  createDatabase,
  locumProfiles,
  shiftOffers,
  shifts,
} from "@locum/db";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const manifestPath =
  process.env["LOADTEST_MANIFEST"] ??
  join(process.cwd(), "results", "manifest.json");

interface Manifest {
  parameters: Record<string, number>;
  shifts: Array<{ shiftId: string; bookingIds: string[] }>;
  fanoutShifts?: Array<{ shiftId: string }>;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const { db, client } = createDatabase({ url: databaseUrl });

try {
  const shiftIds = manifest.shifts.map((s) => s.shiftId);

  const counts = await db
    .select({
      shiftId: bookings.shiftId,
      confirmed: sql<number>`count(*)::int`,
    })
    .from(bookings)
    .where(
      and(inArray(bookings.shiftId, shiftIds), eq(bookings.status, "confirmed")),
    )
    .groupBy(bookings.shiftId);

  const byShift = new Map(counts.map((c) => [c.shiftId, c.confirmed]));

  const doubleBooked = [...byShift.entries()].filter(([, n]) => n > 1);
  const filled = [...byShift.values()].filter((n) => n === 1).length;
  const unfilled = shiftIds.length - byShift.size;

  // Shift status must agree with the bookings — a confirmed booking against a
  // shift still marked 'open' would mean the two writes did not commit
  // together.
  const statusRows = await db
    .select({ id: shifts.id, status: shifts.status })
    .from(shifts)
    .where(inArray(shifts.id, shiftIds));

  const inconsistent = statusRows.filter((s) => {
    const confirmed = byShift.get(s.id) ?? 0;
    return (confirmed === 1 && s.status !== "filled") ||
      (confirmed === 0 && s.status === "filled");
  });

  /*
   * §12.3's OTHER half: the fan-out.
   *
   * The spec asks for row-locking and fan-out exercised together, so the
   * invariants have to cover both. These are the fan-out failures that leave
   * no trace in an HTTP response — every one of them returns 200, and the
   * damage is a message that reached someone it should not have.
   */
  const fanoutShiftIds = (manifest.fanoutShifts ?? []).map((s) => s.shiftId);
  const offerScope = [...shiftIds, ...fanoutShiftIds];

  const offerRows = await db
    .select({
      shiftId: shiftOffers.shiftId,
      locumId: shiftOffers.locumId,
      ring: shiftOffers.ring,
      distanceM: shiftOffers.distanceM,
      maxTravelKm: locumProfiles.maxTravelKm,
    })
    .from(shiftOffers)
    .innerJoin(locumProfiles, eq(locumProfiles.userId, shiftOffers.locumId))
    .where(inArray(shiftOffers.shiftId, offerScope));

  /*
   * The constraint a locum actually feels. `distance_m` is recorded at the
   * moment of the offer precisely so this can be checked afterwards without
   * being confused by someone who has since moved.
   */
  const beyondTravelLimit = offerRows.filter(
    (row) => row.distanceM > row.maxTravelKm * 1000,
  );

  // The unique index should make this impossible. Checked anyway: a duplicate
  // here is a second WhatsApp to a real person, and "impossible" is a claim
  // worth testing under concurrency rather than trusting.
  const seen = new Set<string>();
  const duplicateOffers: string[] = [];
  for (const row of offerRows) {
    const key = `${row.shiftId}:${row.locumId}`;
    if (seen.has(key)) duplicateOffers.push(key);
    seen.add(key);
  }

  const offersByShift = new Map<string, number>();
  for (const row of offerRows) {
    offersByShift.set(row.shiftId, (offersByShift.get(row.shiftId) ?? 0) + 1);
  }
  const overBudget = [...offersByShift.entries()].filter(
    ([, n]) => n > MAX_TOTAL_PER_SHIFT,
  );

  console.log("");
  console.log("=== §12.3 load-test invariant check ===");
  console.log(`  contended shifts:        ${shiftIds.length}`);
  console.log(`  applicants per shift:    ${manifest.parameters["applicantsPerShift"]}`);
  console.log(`  exactly one confirmed:   ${filled}`);
  console.log(`  none confirmed:          ${unfilled}`);
  console.log(`  DOUBLE-BOOKED:           ${doubleBooked.length}`);
  console.log(`  status inconsistencies:  ${inconsistent.length}`);
  console.log("");
  console.log(`  shift offers written:    ${offerRows.length}`);
  console.log(`  shifts fanned out to:    ${offersByShift.size}`);
  console.log(`  BEYOND TRAVEL LIMIT:     ${beyondTravelLimit.length}`);
  console.log(`  DUPLICATE OFFERS:        ${duplicateOffers.length}`);
  console.log(`  OVER PER-SHIFT BUDGET:   ${overBudget.length}`);
  console.log("");

  if (beyondTravelLimit.length > 0) {
    /*
     * Checked before the booking invariants because it is the quieter
     * failure. A double-booking is discovered within hours; a locum messaged
     * about a shift beyond the limit they set simply stops trusting the
     * product, and nobody files a ticket about that.
     */
    console.error(
      "FAIL: a locum was offered a shift beyond their own max_travel_km.",
    );
    for (const row of beyondTravelLimit.slice(0, 10)) {
      console.error(
        `  locum=${row.locumId} offered at ${Math.round(row.distanceM / 1000)}km, limit ${row.maxTravelKm}km`,
      );
    }
    process.exitCode = 1;
  } else if (duplicateOffers.length > 0) {
    console.error("FAIL: the same locum was offered the same shift twice.");
    for (const key of duplicateOffers.slice(0, 10)) console.error(`  ${key}`);
    process.exitCode = 1;
  } else if (overBudget.length > 0) {
    console.error(
      `FAIL: a shift exceeded the ${MAX_TOTAL_PER_SHIFT}-offer lifetime budget.`,
    );
    for (const [shiftId, n] of overBudget.slice(0, 10)) {
      console.error(`  ${shiftId}: ${n} offers`);
    }
    process.exitCode = 1;
  } else if (doubleBooked.length > 0) {
    console.error("FAIL: a shift has more than one confirmed booking.");
    for (const [shiftId, n] of doubleBooked.slice(0, 10)) {
      console.error(`  ${shiftId}: ${n} confirmed`);
    }
    process.exitCode = 1;
  } else if (inconsistent.length > 0) {
    console.error("FAIL: shift status disagrees with its bookings.");
    for (const row of inconsistent.slice(0, 10)) {
      console.error(`  ${row.id}: status=${row.status}, confirmed=${byShift.get(row.id) ?? 0}`);
    }
    process.exitCode = 1;
  } else if (filled === 0) {
    // Zero confirmations means the load never reached the endpoint —
    // a green run that proved nothing.
    console.error(
      "FAIL: no shift was filled. The harness did not exercise the confirm path.",
    );
    process.exitCode = 1;
  } else if (offerRows.length === 0) {
    /*
     * Same reasoning as the zero-confirmations check above, for the other
     * half of the gate: a run in which the fan-out never fired is a green
     * result that proves nothing about it.
     */
    console.error(
      "FAIL: no shift offers were written. The harness did not exercise the fan-out.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      "PASS: at most one confirmed booking per shift, and every offer respected " +
        "the locum's travel limit, the dedupe and the per-shift budget.",
    );
  }
} catch (error) {
  console.error("verify failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}

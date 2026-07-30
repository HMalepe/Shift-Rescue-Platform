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
import { bookings, createDatabase, shifts } from "@locum/db";

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

  console.log("");
  console.log("=== §12.3 load-test invariant check ===");
  console.log(`  contended shifts:        ${shiftIds.length}`);
  console.log(`  applicants per shift:    ${manifest.parameters["applicantsPerShift"]}`);
  console.log(`  exactly one confirmed:   ${filled}`);
  console.log(`  none confirmed:          ${unfilled}`);
  console.log(`  DOUBLE-BOOKED:           ${doubleBooked.length}`);
  console.log(`  status inconsistencies:  ${inconsistent.length}`);
  console.log("");

  if (doubleBooked.length > 0) {
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
  } else {
    console.log("PASS: every contended shift has at most one confirmed booking.");
  }
} catch (error) {
  console.error("verify failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}

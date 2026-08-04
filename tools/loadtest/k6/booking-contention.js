/**
 * §0.3 load harness / §12.3 load-testing gate.
 *
 * §12.3 is specific about what must be exercised, and specific that it must be
 * exercised TOGETHER:
 *
 *   "This should specifically exercise the booking-confirmation row-locking
 *    under concurrent accept attempts, and the notification fan-out path under
 *    a burst, together — not as separate unit tests."
 *
 * So the three scenarios below run simultaneously, contending for the same
 * connection pool and the same Postgres instance. Run separately they all pass
 * comfortably; run together they compete for connections, which is the
 * condition that actually exists when a manager toggles "looking for a locum"
 * while other managers are confirming bookings.
 *
 * UNTIL THE FAN-OUT EXISTED, this file could only approximate it. The second
 * scenario ran the proximity READ the fan-out would use, because
 * `shifts.lookingForLocum` had not been built — a reasonable stand-in that
 * nonetheless exercised none of the writing, the offer deduplication or the
 * per-shift budget. The third scenario now drives the real endpoint.
 *
 * The pass/fail assertion that matters is NOT in this file. k6 measures
 * latency and error rates; whether the row lock held is a database question,
 * checked afterwards by src/verify.ts. A load test that only reported p95
 * would miss a double-booking entirely.
 */
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";

// k6 resolves open() relative to THIS FILE, not the working directory.
const MANIFEST_PATH = __ENV.LOADTEST_MANIFEST || "../results/manifest.json";
const BASE_URL = __ENV.LOADTEST_BASE_URL || "http://localhost:3000";

const CONFIRM_VUS = Number(__ENV.LOADTEST_CONFIRM_VUS || 50);
const BROWSE_RATE = Number(__ENV.LOADTEST_BROWSE_RPS || 30);
const TOGGLE_RATE = Number(__ENV.LOADTEST_TOGGLE_RPS || 4);
const DURATION = __ENV.LOADTEST_DURATION || "30s";

const manifest = new SharedArray("manifest", () => [
  JSON.parse(open(MANIFEST_PATH)),
])[0];

const confirmWon = new Counter("booking_confirm_won");
const confirmLost = new Counter("booking_confirm_lost_cleanly");
const confirmServerError = new Counter("booking_confirm_server_error");
const confirmLatency = new Trend("booking_confirm_latency", true);
const browseLatency = new Trend("proximity_browse_latency", true);
const browseOk = new Rate("proximity_browse_ok");
const fanoutLatency = new Trend("fanout_toggle_latency", true);
const fanoutOk = new Rate("fanout_toggle_ok");
const fanoutOffers = new Counter("fanout_offers_made");
const fanoutServerError = new Counter("fanout_server_error");
const fanoutQuotaBlocked = new Counter("fanout_quota_blocked");

export const options = {
  scenarios: {
    /**
     * Every applicant for a shift tries to be confirmed at once. Exactly one
     * must win per shift; the rest must lose CLEANLY (409), not with a 500.
     */
    booking_contention: {
      executor: "per-vu-iterations",
      vus: CONFIRM_VUS,
      iterations: 1,
      exec: "confirmBooking",
      maxDuration: DURATION,
    },
    /**
     * Concurrent proximity reads — the query the Phase 3 fan-out runs against
     * a favourites list of the configured width.
     */
    proximity_fanout: {
      executor: "constant-arrival-rate",
      rate: BROWSE_RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 100,
      exec: "browseShifts",
    },
    /**
     * §12.3's actual subject: the burst a manager fires by toggling "Looking
     * for a Locum". Each call selects a ring, writes an offer row per
     * candidate and sends a message per offer — all while the contention
     * scenario above is holding row locks on the same database.
     */
    fanout_burst: {
      executor: "constant-arrival-rate",
      rate: TOGGLE_RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 40,
      exec: "toggleLookingForLocum",
    },
  },
  thresholds: {
    // A loser of the race is expected; a 500 is not. Any server error here
    // means the row lock let a caller through to a raw constraint violation.
    booking_confirm_server_error: ["count==0"],
    "booking_confirm_latency": ["p(95)<2000"],
    "proximity_browse_latency": ["p(95)<1500"],
    proximity_browse_ok: ["rate>0.99"],
    /*
     * The fan-out writes and sends, so it is allowed more headroom than a
     * read — but a toggle that takes longer than three seconds is one the
     * manager assumes did not work, and they press it again.
     */
    fanout_toggle_latency: ["p(95)<3000"],
    fanout_server_error: ["count==0"],
  },
};

/**
 * One confirmation attempt.
 *
 * VUs are spread across shifts so several shifts are contended at once rather
 * than all VUs piling onto one — closer to a real morning, and it exercises
 * lock acquisition on many rows instead of a single hot one.
 */
export function confirmBooking() {
  const shiftIndex = (__VU - 1) % manifest.shifts.length;
  const shift = manifest.shifts[shiftIndex];

  // Each VU targets a different applicant on that shift.
  const bookingIndex =
    Math.floor((__VU - 1) / manifest.shifts.length) % shift.bookingIds.length;
  const bookingId = shift.bookingIds[bookingIndex];

  const response = http.post(
    `${BASE_URL}/trpc/bookings.confirm`,
    JSON.stringify({ bookingId }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shift.managerToken}`,
      },
      tags: { name: "bookings.confirm" },
    },
  );

  confirmLatency.add(response.timings.duration);

  if (response.status === 200) {
    confirmWon.add(1);
  } else if (response.status === 409 || response.status === 403) {
    // 409 = already filled / not confirmable. Expected for every loser.
    confirmLost.add(1);
  } else if (response.status >= 500) {
    confirmServerError.add(1);
  }

  check(response, {
    "confirm resolved without a server error": (r) => r.status < 500,
  });
}

/** Proximity read under the same load. */
export function browseShifts() {
  const token =
    manifest.locumTokens[Math.floor(Math.random() * manifest.locumTokens.length)];

  const input = encodeURIComponent(JSON.stringify({ limit: 25 }));
  const response = http.get(
    `${BASE_URL}/trpc/shifts.listOpenForMe?input=${input}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      tags: { name: "shifts.listOpenForMe" },
    },
  );

  browseLatency.add(response.timings.duration);
  browseOk.add(response.status === 200);

  check(response, {
    "browse returned 200": (r) => r.status === 200,
  });
}

/**
 * One "Looking for a Locum" toggle.
 *
 * A 429 is a PASS, not a failure. §12.3's quota deliberately allows only ten
 * an hour per account, precisely because each toggle can cost twenty-five
 * WhatsApp messages — so under a sustained burst most calls SHOULD be
 * rejected, and a run where none were would mean the quota is not working.
 * They are counted separately so the distinction is visible in the summary
 * rather than hidden inside an error rate.
 */
export function toggleLookingForLocum() {
  /*
   * The fan-out's OWN shifts, not the contended ones.
   *
   * The contention scenario confirms every contended shift within the first
   * second, and `selectRing` correctly refuses to notify anyone about a shift
   * that is no longer open — so pointing the burst at those shifts produced a
   * run with zero offers and every threshold green. These shifts stay open for
   * the duration.
   */
  const pool = manifest.fanoutShifts || [];
  if (pool.length === 0) return;
  const shift = pool[Math.floor(Math.random() * pool.length)];

  const response = http.post(
    `${BASE_URL}/trpc/shifts.lookingForLocum`,
    JSON.stringify({ shiftId: shift.shiftId }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shift.managerToken}`,
      },
      tags: { name: "shifts.lookingForLocum" },
    },
  );

  fanoutLatency.add(response.timings.duration);

  if (response.status === 200) {
    fanoutOk.add(true);
    try {
      const offered = response.json("result.data.offered");
      if (typeof offered === "number") fanoutOffers.add(offered);
    } catch (error) {
      // A 200 whose body cannot be read is still a successful request as far
      // as latency goes; the invariant check in src/verify.ts reads the rows.
    }
  } else if (response.status === 429) {
    fanoutQuotaBlocked.add(1);
    fanoutOk.add(true);
  } else if (response.status >= 500) {
    fanoutServerError.add(1);
    fanoutOk.add(false);
  } else {
    fanoutOk.add(false);
  }

  check(response, {
    "toggle resolved without a server error": (r) => r.status < 500,
  });
}

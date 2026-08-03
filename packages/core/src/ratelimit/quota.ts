import { sql } from "drizzle-orm";
import type { Database } from "@locum/db";

/**
 * §12.1 — per-account quotas on the endpoints the spec names.
 *
 * *"Rate limiting on public endpoints: search/browse endpoints, booking-request
 * creation — prevent scraping of locum personal data and abuse of the
 * notification-firing booking flow."*
 *
 * ## Why the existing per-IP limit does not cover this
 *
 * The API already rate-limits by IP, and that is the right control for
 * credential stuffing — an attacker guessing passwords has no account yet, so
 * their address is the only thing to key on.
 *
 * It is the wrong control for the two threats above, and wrong in both
 * directions:
 *
 *   - **It is trivially evaded.** A locum scraping the shift board is
 *     *authenticated*. They already have a verified account, and rotating
 *     through a phone's mobile data gives them a new IP whenever they want
 *     one. An IP limit costs them a reconnect.
 *   - **It punishes the innocent.** Every manager at a pharmacy group behind
 *     one NAT shares a bucket, so the limit that inconveniences an attacker
 *     for a second locks out a real customer for a minute.
 *
 * Keying on the *account* fixes both. The cost is that an unauthenticated
 * caller cannot be limited this way at all — which is fine, because both
 * named endpoints require authentication.
 *
 * ## Why Postgres and not Redis
 *
 * Redis is the conventional answer and it is already in the stack for BullMQ.
 * It is not used here for one reason: this runs on the request path of the
 * busiest read in the product, and adding a second datastore to that path adds
 * a second way for browse to be down. Postgres is already open, already hot,
 * and the volume is one small upsert per limited call.
 *
 * The window is fixed rather than sliding. A fixed window permits a burst of
 * up to 2× the limit across a boundary, which for "stop someone downloading
 * the whole shift board" is an entirely acceptable imprecision — and it costs
 * one row instead of a sorted set per user.
 */

export interface QuotaRule {
  /** Stable name; also the storage key prefix. */
  readonly action: string;
  readonly limit: number;
  readonly windowSeconds: number;
  /** Why this number. Every quota states its reasoning. */
  readonly because: string;
}

/**
 * The quotas.
 *
 * Both are set well above what a person doing their job could reach, and well
 * below what makes bulk extraction practical. A limit tuned so tightly that
 * real use trips it gets raised in an incident and never lowered again.
 */
export const QUOTAS = {
  /**
   * §10.1 browse. A locum refreshing the board while waiting for a shift to
   * appear might reload a few times a minute; nobody legitimately makes 120
   * calls an hour.
   */
  browseShifts: {
    action: "shifts.browse",
    limit: 120,
    windowSeconds: 3_600,
    because:
      "Each call returns up to 25 shifts with pharmacy names and coordinates. 120/hour is far past human use and far below what makes enumerating the market worthwhile.",
  },
  /**
   * Booking requests. This is the one §12.1 calls "the notification-firing
   * booking flow": every application notifies a manager, so an unbounded
   * applicant is a spam vector aimed at a real person's phone rather than at
   * our infrastructure.
   */
  applyToShift: {
    action: "bookings.apply",
    limit: 30,
    windowSeconds: 3_600,
    because:
      "Every application fires a manager notification (§4.4). Thirty an hour is more shifts than exist nearby; beyond that it is someone using our WhatsApp sender to bother pharmacists.",
  },
  /**
   * §12.3 — the "Looking for a Locum" toggle.
   *
   * The tightest quota in this file, and the only one where the cost is
   * primarily OURS. One toggle can send twenty-five WhatsApp messages
   * immediately and up to sixty across escalation, each of them billed and
   * each landing on a real pharmacist's phone. A manager toggling a shift on
   * and off is therefore the most efficient way an authenticated account has
   * to spend §11.6's daily budget — and unlike scraping, it does not even
   * require bad intent, just an anxious manager and a slow morning.
   *
   * Ten an hour is more shifts than a single pharmacy has open at once.
   */
  lookingForLocum: {
    action: "shifts.looking_for_locum",
    limit: 10,
    windowSeconds: 3_600,
    because:
      "One toggle can cost 25 WhatsApp messages immediately and 60 across escalation. This is the only quota where the expense is ours rather than the database's.",
  },
  /**
   * §10 data exports. Not scraping — but an export is the single densest
   * payload in the system, and repeatedly generating one is a cheap way to
   * make the database do expensive work.
   */
  dataExport: {
    action: "privacy.export",
    limit: 5,
    windowSeconds: 3_600,
    because:
      "An export reads every table for one subject. Nobody needs five an hour, and it is the most expensive query a user can trigger.",
  },
} as const satisfies Record<string, QuotaRule>;

export interface QuotaResult {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
  /** Seconds until the window resets. Sent as Retry-After. */
  readonly resetInSeconds: number;
}

/**
 * Consumes one unit of a subject's quota.
 *
 * The count is incremented BEFORE the decision, and a rejected call still
 * counts. That is deliberate: if hitting the limit were free, an attacker
 * would keep hammering it at no cost, and the window would never drain while
 * they kept trying. Refusals costing quota is what makes backing off the only
 * way through.
 */
export async function consumeQuota(
  db: Database,
  rule: QuotaRule,
  subjectId: string,
  now: Date = new Date(),
): Promise<QuotaResult> {
  const windowStart = new Date(
    Math.floor(now.getTime() / (rule.windowSeconds * 1000)) *
      rule.windowSeconds *
      1000,
  );

  /*
   * One statement. A read-then-write would race two concurrent requests from
   * the same account into both seeing the same count — which is exactly the
   * situation a rate limiter exists to handle, so losing to it would be
   * embarrassing.
   */
  const rows = await db.execute<{ used: number }>(sql`
    insert into rate_limit_counters (subject_id, action, window_start, used)
    values (${subjectId}::uuid, ${rule.action}, ${windowStart.toISOString()}::timestamptz, 1)
    on conflict (subject_id, action, window_start)
      do update set used = rate_limit_counters.used + 1
    returning used
  `);

  const used = [...rows][0]?.used ?? 1;
  const resetAt = windowStart.getTime() + rule.windowSeconds * 1000;

  return {
    allowed: used <= rule.limit,
    used,
    limit: rule.limit,
    resetInSeconds: Math.max(0, Math.ceil((resetAt - now.getTime()) / 1000)),
  };
}

/**
 * Removes counters for windows that have closed.
 *
 * Run from the worker. Without it this table grows by one row per active user
 * per action per window, forever — a rate limiter that becomes the largest
 * table in the database is a self-inflicted outage.
 */
export async function sweepExpiredQuotas(
  db: Database,
  olderThanHours = 48,
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    delete from rate_limit_counters
     where window_start < now() - make_interval(hours => ${olderThanHours})
    returning subject_id as id
  `);
  return [...rows].length;
}

import { sql } from "drizzle-orm";
import type { Database } from "@locum/db";

/**
 * §12.2 — the operations dashboard.
 *
 * The spec names four things it must cover, and they are not arbitrary:
 * *"booking confirmation success rate, WhatsApp delivery/spend (§11.6–11.7),
 * settlement/dunning success rate, and PostGIS query latency as usage grows."*
 *
 * Each maps to a way the business stops working, which is why these four and
 * not the usual CPU-and-memory panel:
 *
 *   - **Booking confirmation** failing means a pharmacy cannot secure cover.
 *     §12.2 is explicit: "booking and attendance downtime stops a pharmacy
 *     trading".
 *   - **WhatsApp delivery** failing means bookings are confirmed and nobody is
 *     told. That is the worst shape of failure this system has, because every
 *     internal indicator stays green (§11.7).
 *   - **Dunning** failing means revenue quietly stops arriving.
 *   - **PostGIS latency** is the one that degrades rather than breaks. Proximity
 *     search gets slower as the locum pool grows, and there is no moment at
 *     which it fails — only a week where the app feels bad.
 *
 * ## Read from Postgres, not from a metrics pipeline
 *
 * These are counted from the rows themselves rather than from
 * counters incremented in application code. Three reasons, and the third is
 * the real one:
 *
 *   1. They are exact. A counter that missed an increment during a deploy
 *      produces a success rate that is quietly wrong.
 *   2. They are historical. A new panel can be asked about last month.
 *   3. **A counter can only be wrong in the flattering direction.** The
 *      failure mode of instrumenting application code is that the code path
 *      which never runs also never increments its failure counter — so the
 *      dashboard is greenest exactly when a path is broken. Rows do not have
 *      that property: a booking that was never confirmed is visibly a booking
 *      that was never confirmed.
 *
 * The cost is that these are queries over live tables. They are bounded to a
 * rolling window and indexed accordingly; if that stops being cheap, the fix
 * is a materialised rollup, not a counter.
 */

export interface DashboardWindow {
  /** Rolling window, in hours. */
  readonly hours: number;
}

export interface BookingHealth {
  readonly requested: number;
  readonly confirmed: number;
  /** Requests that reached a confirmed booking, as a fraction. */
  readonly confirmationRate: number | null;
  readonly cancelledByLocum: number;
  readonly cancelledByPharmacy: number;
  readonly noShows: number;
  /**
   * Shifts that went unfilled and have now started.
   *
   * The number that matters most on this page and the only one not visible
   * from an error rate: nothing failed, no exception was thrown, and a
   * pharmacy opened without a pharmacist.
   */
  readonly unfilledAtStart: number;
}

export interface MessagingHealth {
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
  readonly queued: number;
  /** §11.7 — of what was sent, how much is confirmed to have arrived. */
  readonly deliveryRate: number | null;
  /** §11.6 — billable spend inside the window, in cents. */
  readonly spendCents: number;
  /** Deferred messages past due and still unclaimed — the drain falling behind. */
  readonly overdueBacklog: number;
}

export interface BillingHealth {
  readonly attempted: number;
  readonly succeeded: number;
  readonly retrying: number;
  readonly abandoned: number;
  readonly successRate: number | null;
  /**
   * Charges stuck without a definite answer from the provider.
   *
   * Called out separately because it is the only one that can mean money moved
   * without us knowing (§2). A rising count here is a provider incident, not a
   * batch of bad cards.
   */
  readonly unresolved: number;
  readonly collectedCents: number;
  readonly restrictedSubscriptions: number;
}

export interface GeoHealth {
  /** Rows the proximity index must consider — the thing that grows. */
  readonly openShifts: number;
  readonly locumsWithLocation: number;
  /** Measured, not estimated: a representative proximity query, timed. */
  readonly proximityQueryMs: number;
}

export interface OpsDashboard {
  readonly windowHours: number;
  readonly generatedAt: Date;
  readonly booking: BookingHealth;
  readonly messaging: MessagingHealth;
  readonly billing: BillingHealth;
  readonly geo: GeoHealth;
}

const JOHANNESBURG = { lng: 28.0473, lat: -26.2041 } as const;

export async function getOpsDashboard(
  db: Database,
  window: DashboardWindow = { hours: 24 },
): Promise<OpsDashboard> {
  const hours = window.hours;

  /*
   * Four independent queries, run concurrently. Deliberately not one big
   * query with CTEs: these read different tables with different indexes, and
   * a single statement would make the slowest one the latency of the page —
   * as well as making any one of them impossible to EXPLAIN on its own.
   */
  const [booking, messaging, billing, geo] = await Promise.all([
    bookingHealth(db, hours),
    messagingHealth(db, hours),
    billingHealth(db, hours),
    geoHealth(db),
  ]);

  return { windowHours: hours, generatedAt: new Date(), booking, messaging, billing, geo };
}

async function bookingHealth(db: Database, hours: number): Promise<BookingHealth> {
  const rows = await db.execute<{
    requested: number;
    confirmed: number;
    cancelled_by_locum: number;
    cancelled_by_pharmacy: number;
    no_shows: number;
    unfilled_at_start: number;
  }>(sql`
    select
      count(*) filter (where b.requested_at > now() - make_interval(hours => ${hours}))::int
        as requested,
      count(*) filter (
        where b.status = 'confirmed'
          and b.confirmed_at > now() - make_interval(hours => ${hours})
      )::int as confirmed,
      count(*) filter (
        where b.status = 'cancelled_by_locum'
          and b.updated_at > now() - make_interval(hours => ${hours})
      )::int as cancelled_by_locum,
      count(*) filter (
        where b.status = 'cancelled_by_manager'
          and b.updated_at > now() - make_interval(hours => ${hours})
      )::int as cancelled_by_pharmacy,
      count(*) filter (
        where b.status = 'no_show'
          and b.updated_at > now() - make_interval(hours => ${hours})
      )::int as no_shows,
      (
        select count(*)::int from shifts s
         where s.status = 'open'
           and s.starts_at < now()
           and s.starts_at > now() - make_interval(hours => ${hours})
      ) as unfilled_at_start
    from bookings b
  `);

  const row = [...rows][0]!;
  return {
    requested: row.requested,
    confirmed: row.confirmed,
    confirmationRate: rate(row.confirmed, row.requested),
    cancelledByLocum: row.cancelled_by_locum,
    cancelledByPharmacy: row.cancelled_by_pharmacy,
    noShows: row.no_shows,
    unfilledAtStart: row.unfilled_at_start,
  };
}

async function messagingHealth(db: Database, hours: number): Promise<MessagingHealth> {
  const rows = await db.execute<{
    sent: number;
    delivered: number;
    failed: number;
    queued: number;
    spend_cents: number;
    overdue_backlog: number;
  }>(sql`
    select
      count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent,
      count(*) filter (where status in ('delivered', 'read'))::int as delivered,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'queued')::int as queued,
      coalesce(sum(price_cents), 0)::int as spend_cents,
      count(*) filter (
        where status = 'queued'
          and scheduled_for is not null
          and scheduled_for < now()
          and claimed_at is null
      )::int as overdue_backlog
    from whatsapp_message_log
    where direction = 'outbound'
      and created_at > now() - make_interval(hours => ${hours})
  `);

  const row = [...rows][0]!;
  return {
    sent: row.sent,
    delivered: row.delivered,
    failed: row.failed,
    queued: row.queued,
    /*
     * §11.7 — "a 'sent' event with no delivery confirmation is not evidence
     * anything reached anyone". This ratio is the whole reason that table
     * records delivery status separately from send status.
     */
    deliveryRate: rate(row.delivered, row.sent),
    spendCents: row.spend_cents,
    overdueBacklog: row.overdue_backlog,
  };
}

async function billingHealth(db: Database, hours: number): Promise<BillingHealth> {
  const rows = await db.execute<{
    attempted: number;
    succeeded: number;
    retrying: number;
    abandoned: number;
    unresolved: number;
    collected_cents: number;
    restricted: number;
  }>(sql`
    select
      count(*)::int as attempted,
      count(*) filter (where status = 'succeeded')::int as succeeded,
      count(*) filter (where status = 'retrying')::int as retrying,
      count(*) filter (where status = 'abandoned')::int as abandoned,
      count(*) filter (where status = 'pending' and attempt > 1)::int as unresolved,
      coalesce(sum(amount_cents) filter (where status = 'succeeded'), 0)::int
        as collected_cents,
      (select count(*)::int from subscriptions where status = 'restricted') as restricted
    from subscription_charges
    where created_at > now() - make_interval(hours => ${hours})
  `);

  const row = [...rows][0]!;
  return {
    attempted: row.attempted,
    succeeded: row.succeeded,
    retrying: row.retrying,
    abandoned: row.abandoned,
    successRate: rate(row.succeeded, row.attempted),
    unresolved: row.unresolved,
    collectedCents: row.collected_cents,
    restrictedSubscriptions: row.restricted,
  };
}

/**
 * §12.2 — "PostGIS query latency as usage grows".
 *
 * Timed by running a representative proximity search, not estimated from
 * planner costs. §0.1 is explicit that query-planner behaviour does not port
 * between environments, and a cost estimate is a prediction about a machine
 * that may not be this one. The counts alongside it are what makes a rising
 * number interpretable: 40ms over 200 shifts and 40ms over 20,000 are very
 * different pieces of news.
 */
async function geoHealth(db: Database): Promise<GeoHealth> {
  const counts = await db.execute<{ open_shifts: number; locums: number }>(sql`
    select
      (select count(*)::int from shifts where status = 'open') as open_shifts,
      (select count(*)::int from locum_profiles where base_location is not null) as locums
  `);

  const started = performance.now();
  await db.execute(sql`
    select s.id
      from shifts s
     where s.status = 'open'
       and ST_DWithin(
             s.location,
             ST_SetSRID(ST_MakePoint(${JOHANNESBURG.lng}, ${JOHANNESBURG.lat}), 4326)::geography,
             25000
           )
     order by ST_Distance(
       s.location,
       ST_SetSRID(ST_MakePoint(${JOHANNESBURG.lng}, ${JOHANNESBURG.lat}), 4326)::geography
     )
     limit 25
  `);
  const elapsed = performance.now() - started;

  const row = [...counts][0]!;
  return {
    openShifts: row.open_shifts,
    locumsWithLocation: row.locums,
    proximityQueryMs: Math.round(elapsed * 10) / 10,
  };
}

/** Null rather than 0 when the denominator is zero — see the UI note. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

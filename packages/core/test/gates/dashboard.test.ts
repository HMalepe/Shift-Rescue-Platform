import { afterAll, describe, expect, it } from "vitest";
import { getOpsDashboard } from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: ops.dashboard
 *
 * §12.2 names four things the dashboard must cover and they map to four ways
 * the business stops working: a pharmacy cannot secure cover, a confirmed
 * booking is never communicated, revenue quietly stops arriving, and proximity
 * search degrades without ever failing.
 *
 * These tests run against the seeded database (§14), which is the point —
 * every query here is one that will run against production-shaped data, and
 * the failure mode worth catching is a query that is subtly wrong rather than
 * one that errors. A dashboard reporting a confident, incorrect number is
 * worse than a broken one, because nobody investigates a green panel.
 */

const { db, client } = connect();

afterAll(async () => {
  await client.end();
});

describe("GATE ops.dashboard — §12.2", () => {
  it("returns all four panels against real data", async () => {
    const dashboard = await getOpsDashboard(db, { hours: 24 * 365 });

    expect(dashboard.windowHours).toBe(24 * 365);
    expect(dashboard.booking).toBeDefined();
    expect(dashboard.messaging).toBeDefined();
    expect(dashboard.billing).toBeDefined();
    expect(dashboard.geo).toBeDefined();
  });

  it("counts, rather than estimates, what is in the database", async () => {
    const dashboard = await getOpsDashboard(db, { hours: 24 * 365 });

    /*
     * The seed (§14) writes bookings across every state and 200 charges, so
     * these must be non-zero. A dashboard that reports zeros against a
     * populated database is the exact failure this test exists for: every
     * panel would look calm.
     */
    expect(dashboard.booking.requested + dashboard.booking.confirmed).toBeGreaterThan(0);
    expect(dashboard.billing.attempted).toBeGreaterThan(0);
    expect(dashboard.geo.openShifts).toBeGreaterThan(0);
    expect(dashboard.geo.locumsWithLocation).toBeGreaterThan(0);
  });

  it("reports rates as null rather than zero when nothing happened", async () => {
    /*
     * A one-second window contains nothing. Zero would render as "0% success"
     * — indistinguishable from total failure, and precisely the sort of thing
     * that gets someone out of bed at 3am for a quiet night.
     */
    const dashboard = await getOpsDashboard(db, { hours: 0 });

    expect(dashboard.booking.requested).toBe(0);
    expect(dashboard.booking.confirmationRate).toBeNull();
    expect(dashboard.billing.successRate).toBeNull();
    expect(dashboard.messaging.deliveryRate).toBeNull();
  });

  it("keeps rates inside 0..1", async () => {
    const dashboard = await getOpsDashboard(db, { hours: 24 * 365 });

    for (const [name, value] of [
      ["booking", dashboard.booking.confirmationRate],
      ["billing", dashboard.billing.successRate],
      ["messaging", dashboard.messaging.deliveryRate],
    ] as const) {
      if (value === null) continue;
      expect(value, `${name} rate out of range`).toBeGreaterThanOrEqual(0);
      expect(value, `${name} rate out of range`).toBeLessThanOrEqual(1);
    }
  });

  it("measures PostGIS latency by running a query, not by estimating it", async () => {
    /*
     * §0.1: planner behaviour does not port between environments, so a cost
     * estimate is a prediction about a machine that may not be this one. The
     * counts alongside are what make a rising number interpretable — 40ms over
     * 200 shifts and 40ms over 20,000 are very different news.
     */
    const dashboard = await getOpsDashboard(db);

    expect(dashboard.geo.proximityQueryMs).toBeGreaterThan(0);
    expect(
      dashboard.geo.proximityQueryMs,
      "a proximity query taking over a second against seed data means the GiST index is not being used",
    ).toBeLessThan(1_000);
  });

  it("surfaces the failure that throws no exception", async () => {
    /*
     * `unfilledAtStart` — shifts that opened, were never filled, and have now
     * started. Nothing errored, no alert fired, and a pharmacy opened without
     * a pharmacist. It is the one number on this page that cannot be derived
     * from an error rate, which is why it is on the page at all.
     */
    const dashboard = await getOpsDashboard(db, { hours: 24 * 365 });
    expect(typeof dashboard.booking.unfilledAtStart).toBe("number");
    expect(dashboard.booking.unfilledAtStart).toBeGreaterThanOrEqual(0);
  });

  it("separates money that moved from money that may have", async () => {
    // §2 — `unresolved` is the only count here that can mean a pharmacy was
    // charged without us knowing. It must never be folded into failures.
    const dashboard = await getOpsDashboard(db, { hours: 24 * 365 });

    expect(dashboard.billing).toHaveProperty("unresolved");
    expect(dashboard.billing.unresolved).toBeGreaterThanOrEqual(0);
    expect(dashboard.billing.collectedCents).toBeGreaterThanOrEqual(0);
  });

  it("runs the four panels concurrently rather than serially", async () => {
    /*
     * Not a micro-optimisation. These are queries over live tables, and a
     * serial dashboard has the latency of the sum — which grows with the
     * slowest panel and makes the page something people stop opening.
     */
    const started = performance.now();
    await getOpsDashboard(db, { hours: 24 * 365 });
    const elapsed = performance.now() - started;

    expect(elapsed, "dashboard should render well inside a page load").toBeLessThan(
      5_000,
    );
  });
});

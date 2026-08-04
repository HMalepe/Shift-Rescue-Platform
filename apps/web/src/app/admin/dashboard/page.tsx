import { api } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { formatRands } from "@/lib/format";

interface Dashboard {
  windowHours: number;
  generatedAt: string;
  booking: {
    requested: number;
    confirmed: number;
    confirmationRate: number | null;
    cancelledByLocum: number;
    cancelledByPharmacy: number;
    noShows: number;
    unfilledAtStart: number;
  };
  messaging: {
    sent: number;
    delivered: number;
    failed: number;
    queued: number;
    deliveryRate: number | null;
    spendCents: number;
    overdueBacklog: number;
  };
  billing: {
    attempted: number;
    succeeded: number;
    retrying: number;
    abandoned: number;
    successRate: number | null;
    unresolved: number;
    collectedCents: number;
    restrictedSubscriptions: number;
  };
  geo: { openShifts: number; locumsWithLocation: number; proximityQueryMs: number };
}

/**
 * §12.2's dashboard.
 *
 * Two presentation rules carry most of the value here.
 *
 * A rate with no denominator renders as "—", never as 0%. Zero percent success
 * and "nothing happened yet" look identical on a chart and mean opposite
 * things, and the one that gets someone out of bed at 3am is the wrong one.
 *
 * The numbers that indicate a *silent* failure are given their own emphasis
 * rather than being buried in a grid: shifts that started unfilled, deferred
 * messages past due, and charges with no answer from the provider. None of
 * those raises an exception, so none of them will ever appear in the alerting
 * built in §0.1 — this page is the only place they surface at all.
 */
function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/**
 * "Last 8760 hours" is technically correct and reads like a machine wrote it.
 * People think in days and weeks, so the label does too.
 */
function windowLabel(hours: number): string {
  if (hours < 48) return `${hours} hours`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return days === 365 ? "12 months" : `${(days / 365).toFixed(1)} years`;
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "ok" | "warn" | "danger";
}) {
  const colour =
    tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : undefined;
  return (
    <div className="card">
      <div className="hint" style={{ marginTop: 0 }}>{label}</div>
      <div style={{ fontSize: "1.6rem", fontWeight: 600, letterSpacing: "-0.02em", color: colour }}>
        {value}
      </div>
      {note ? <div className="hint">{note}</div> : null}
    </div>
  );
}

export default async function OpsDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  const viewer = await requireRole("admin");
  const { hours } = await searchParams;
  const windowHours = Number(hours) > 0 ? Number(hours) : 24;

  const d = await api.query<Dashboard>("ops.dashboard", { hours: windowHours });

  const grid = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
    gap: "0.75rem",
  } as const;

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <h1>Operations</h1>
        <p className="lede">
          Last {windowLabel(d.windowHours)}.{" "}
          {[24, 168, 720].map((h) => (
            <a key={h} href={`/admin/dashboard?hours=${h}`} style={{ marginRight: "0.75rem" }}>
              {h === 24 ? "24h" : h === 168 ? "7d" : "30d"}
            </a>
          ))}
        </p>

        <h2>Cover secured</h2>
        <div style={grid}>
          <Stat label="Confirmation rate" value={percent(d.booking.confirmationRate)} note={`${d.booking.confirmed} of ${d.booking.requested} requests`} />
          <Stat
            label="Started unfilled"
            value={String(d.booking.unfilledAtStart)}
            note="Nothing errored. Nobody arrived."
            tone={d.booking.unfilledAtStart > 0 ? "danger" : "ok"}
          />
          <Stat label="Cancelled by locum" value={String(d.booking.cancelledByLocum)} />
          <Stat label="Cancelled by pharmacy" value={String(d.booking.cancelledByPharmacy)} />
          <Stat label="No-shows" value={String(d.booking.noShows)} tone={d.booking.noShows > 0 ? "warn" : "ok"} />
        </div>

        <h2>Messages actually delivered</h2>
        <div style={grid}>
          <Stat label="Delivery rate" value={percent(d.messaging.deliveryRate)} note={`${d.messaging.delivered} of ${d.messaging.sent} sent`} />
          <Stat
            label="Overdue backlog"
            value={String(d.messaging.overdueBacklog)}
            note="Due and undrained"
            tone={d.messaging.overdueBacklog > 0 ? "danger" : "ok"}
          />
          <Stat label="Failed" value={String(d.messaging.failed)} tone={d.messaging.failed > 0 ? "warn" : "ok"} />
          <Stat label="Spend" value={formatRands(d.messaging.spendCents)} note="§11.6 billable conversations" />
        </div>

        <h2>Money collected</h2>
        <div style={grid}>
          <Stat label="Settlement rate" value={percent(d.billing.successRate)} note={`${d.billing.succeeded} of ${d.billing.attempted}`} />
          <Stat
            label="Unresolved"
            value={String(d.billing.unresolved)}
            note="May have moved. No answer."
            tone={d.billing.unresolved > 0 ? "danger" : "ok"}
          />
          <Stat label="Collected" value={formatRands(d.billing.collectedCents)} />
          <Stat label="Retrying" value={String(d.billing.retrying)} />
          <Stat label="Restricted" value={String(d.billing.restrictedSubscriptions)} note="Cannot post shifts" tone={d.billing.restrictedSubscriptions > 0 ? "warn" : "ok"} />
        </div>

        <h2>Proximity search</h2>
        <div style={grid}>
          <Stat
            label="Query time"
            value={`${d.geo.proximityQueryMs} ms`}
            note="Measured, not estimated"
            tone={d.geo.proximityQueryMs > 250 ? "warn" : "ok"}
          />
          <Stat label="Open shifts" value={String(d.geo.openShifts)} />
          <Stat label="Locums with a location" value={String(d.geo.locumsWithLocation)} />
        </div>

        <p className="hint" style={{ marginTop: "2rem" }}>
          Generated {new Date(d.generatedAt).toISOString()}. Counted from rows, not from
          application counters — a counter that missed an increment reports success.
        </p>
      </main>
    </>
  );
}

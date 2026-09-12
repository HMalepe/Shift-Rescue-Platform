import Link from "next/link";
import { api } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { badgeToneFor, formatRands, formatTimeRange } from "@/lib/format";

interface ManagerShift {
  id: string;
  startsAt: string;
  endsAt: string;
  hourlyRateCents: number;
  status: string;
  visibility: "favourites_only" | "radius";
  radiusKm: number | null;
  notes: string | null;
  pharmacyName: string;
  suburb: string | null;
  applicants: number;
}

export default async function ShiftsPage() {
  const viewer = await requireRole("manager");
  const shifts = await api.query<ManagerShift[]>("shifts.mine", { limit: 50 });

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <div className="spread">
          <div>
            <h1>Shifts</h1>
            <p className="lede">Everything coming up at your pharmacies.</p>
          </div>
          <Link href="/shifts/new" className="button primary">
            Post a shift
          </Link>
        </div>

        {shifts.length > 0 ? (
          <p className="dim" style={{ marginTop: "-1rem", marginBottom: "1.75rem" }}>
            {shifts.length} upcoming · {shifts.reduce((n, s) => n + s.applicants, 0)}{" "}
            total applicants
            {shifts.some((s) => s.applicants === 0) ? (
              <> · <strong>{shifts.filter((s) => s.applicants === 0).length} with no applicants yet</strong></>
            ) : null}
          </p>
        ) : null}

        {shifts.length === 0 ? (
          <p className="empty">
            No upcoming shifts. <Link href="/shifts/new">Post one</Link> and your saved
            locums will see it first.
          </p>
        ) : (
          <div className="stack">
            {shifts.map((shift) => (
              <article key={shift.id} className="card">
                <div className="spread">
                  <div>
                    <div className="row">
                      <strong>{formatTimeRange(shift.startsAt, shift.endsAt)}</strong>
                      <span className={badgeToneFor(shift.status)}>{shift.status}</span>
                    </div>
                    <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                      {shift.pharmacyName}
                      {shift.suburb ? `, ${shift.suburb}` : ""} ·{" "}
                      {formatRands(shift.hourlyRateCents)}/hour
                    </p>
                    <p className="hint" style={{ marginTop: "0.35rem" }}>
                      {/*
                        §10.1 surfaced on every row, not buried in an edit
                        screen. "Who can see this?" was one of the two
                        complaints that came straight out of live WhatsApp
                        usage, and a manager should never have to click to find
                        out how far a post reached.
                      */}
                      {shift.visibility === "favourites_only"
                        ? "Visible to your saved locums only"
                        : `Visible within ${shift.radiusKm} km`}
                    </p>
                  </div>

                  <Link href={`/shifts/${shift.id}`} className="button">
                    {shift.applicants === 1
                      ? "1 applicant"
                      : `${shift.applicants} applicants`}
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { formatDistance, formatRands, formatTimeRange } from "@/lib/format";

interface OpenShift {
  id: string;
  startsAt: string;
  endsAt: string;
  hourlyRateCents: number;
  notes: string | null;
  pharmacyName: string;
  suburb: string | null;
  city: string;
  distanceMetres: number;
}

interface VerificationStatus {
  verification: string;
}

/**
 * Shifts a locum can actually take, nearest first.
 *
 * The API decides what appears here — favourites-only shifts require the locum
 * to be on that pharmacy's saved list, radius shifts require them to be inside
 * both the shift's radius and their own `maxTravelKm` (§10.1/§4.4). That
 * filtering deliberately does not exist in this file: a client that received
 * every open shift and hid some would still have shipped them to the browser,
 * which is the scraping risk §12.1 names.
 */
export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const viewer = await requireRole("locum");
  const [shifts, status, { error, notice }] = await Promise.all([
    api.query<OpenShift[]>("shifts.listOpenForMe", { limit: 25 }),
    api.query<VerificationStatus>("verification.myStatus"),
    searchParams,
  ]);

  async function apply(formData: FormData) {
    "use server";
    const shiftId = String(formData.get("shiftId") ?? "");

    try {
      await api.mutate("bookings.applyToShift", {
        shiftId,
        /*
         * §11.5 — a client-generated idempotency key. The scenario is
         * specific: a locum on a train tapping Apply twice on a flaky
         * connection. Without this the second tap is a second application,
         * and the manager sees the same person listed twice.
         */
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not apply for this shift";
      redirect(`/browse?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/browse");
    redirect(`/browse?notice=${encodeURIComponent("Applied. The pharmacy will confirm.")}`);
  }

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <h1>Find shifts</h1>
        <p className="lede">
          {shifts.length === 0
            ? "Open shifts you can take, nearest first."
            : `${shifts.length} open shift${shifts.length === 1 ? "" : "s"} near you, nearest first.`}
        </p>

        {status.verification !== "verified" ? (
          <p className="alert alert-note">
            {/*
              §5's verified-vs-complete distinction, stated plainly. A locum
              whose documents are still in review can browse but cannot be
              confirmed, and finding that out only after applying wastes both
              sides' time.
            */}
            Your registration is <strong>{status.verification}</strong>. Pharmacies can
            only confirm verified locums.{" "}
            <Link href="/profile">Finish your profile</Link> so an admin can check it.
          </p>
        ) : null}

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="alert alert-note" role="status">
            {notice}
          </p>
        ) : null}

        {shifts.length === 0 ? (
          <p className="empty">
            Nothing open for you right now. Shifts appear here when a pharmacy that has
            saved you posts one, or when a shift is advertised within your travel range.
          </p>
        ) : (
          <div className="stack">
            {shifts.map((shift) => (
              <article key={shift.id} className="card">
                <div className="spread">
                  <div>
                    <strong>{formatTimeRange(shift.startsAt, shift.endsAt)}</strong>
                    <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                      {shift.pharmacyName}
                      {shift.suburb ? `, ${shift.suburb}` : `, ${shift.city}`} ·{" "}
                      {formatDistance(shift.distanceMetres)} away
                    </p>
                    <p style={{ margin: "0.4rem 0 0" }}>
                      {formatRands(shift.hourlyRateCents)}/hour
                    </p>
                    {shift.notes ? (
                      <p className="hint" style={{ marginTop: "0.5rem", maxWidth: "40rem" }}>
                        {shift.notes}
                      </p>
                    ) : null}
                  </div>

                  <form action={apply}>
                    <input type="hidden" name="shiftId" value={shift.id} />
                    <button type="submit" className="primary">
                      Apply
                    </button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

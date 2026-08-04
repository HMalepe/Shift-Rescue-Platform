import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";

interface Pharmacy {
  id: string;
  name: string;
  suburb: string | null;
  city: string;
}

/**
 * Post a shift.
 *
 * The one decision on this page that is not obvious is the visibility control,
 * and §10.1 is explicit about it: the default reach is saved locums only, and
 * widening to a radius is "an explicit, separate action the manager takes —
 * not the default". So the radio starts on favourites, and the radius input is
 * inert until the manager chooses it. The API refuses a radius shift with no
 * radius, so this is a convenience, not the enforcement.
 */
export default async function NewShiftPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const viewer = await requireRole("manager");
  const [pharmacies, { error }] = await Promise.all([
    api.query<Pharmacy[]>("profile.myPharmacies"),
    searchParams,
  ]);

  async function create(formData: FormData) {
    "use server";

    const visibility = String(formData.get("visibility") ?? "favourites_only");
    const radiusKm = Number(formData.get("radiusKm"));
    const notes = String(formData.get("notes") ?? "").trim();

    /*
     * The datetime-local inputs give a wall-clock string with no zone. Read as
     * UTC that is two hours wrong in South Africa — an 07:00 shift posted as
     * 09:00. The offset is appended explicitly rather than trusting the
     * server's timezone, which in a container is UTC and would silently
     * produce exactly that bug.
     */
    const toSast = (value: string) => new Date(`${value}:00+02:00`).toISOString();

    try {
      await api.mutate("shifts.create", {
        pharmacyId: String(formData.get("pharmacyId") ?? ""),
        startsAt: toSast(String(formData.get("startsAt") ?? "")),
        endsAt: toSast(String(formData.get("endsAt") ?? "")),
        hourlyRateCents: Math.round(Number(formData.get("hourlyRate") ?? 0) * 100),
        visibility,
        ...(visibility === "radius" && Number.isFinite(radiusKm) ? { radiusKm } : {}),
        ...(notes !== "" && { notes }),
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not post the shift";
      redirect(`/shifts/new?error=${encodeURIComponent(message)}`);
    }

    redirect("/shifts");
  }

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "38rem" }}>
        <h1>Post a shift</h1>
        <p className="lede">
          Your saved locums see this first. Widening the reach is a separate choice.
        </p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        {pharmacies.length === 0 ? (
          <p className="empty">
            Your account is not linked to a pharmacy yet. An administrator needs to add
            you before you can post shifts.
          </p>
        ) : (
          <form action={create} className="card">
            <div className="field">
              <label htmlFor="pharmacyId">Pharmacy</label>
              <select id="pharmacyId" name="pharmacyId" required>
                {pharmacies.map((pharmacy) => (
                  <option key={pharmacy.id} value={pharmacy.id}>
                    {pharmacy.name}
                    {pharmacy.suburb ? `, ${pharmacy.suburb}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="startsAt">Starts</label>
                <input id="startsAt" name="startsAt" type="datetime-local" required />
              </div>
              <div className="field">
                <label htmlFor="endsAt">Ends</label>
                <input id="endsAt" name="endsAt" type="datetime-local" required />
              </div>
            </div>
            <p className="hint" style={{ marginTop: "-0.6rem", marginBottom: "1rem" }}>
              Times are South African Standard Time.
            </p>

            <div className="field">
              <label htmlFor="hourlyRate">Rate per hour (R)</label>
              <input
                id="hourlyRate"
                name="hourlyRate"
                type="number"
                min="0"
                step="10"
                required
                defaultValue={450}
              />
              <p className="hint">
                {/*
                  §10.0 — the rate is advertised so a locum can decide whether
                  to take the shift. The platform never handles this money;
                  wages are paid by the pharmacy's own payroll.
                */}
                Paid by your pharmacy directly. Locum Planner never handles wages.
              </p>
            </div>

            <fieldset
              style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.9rem", marginBottom: "1rem" }}
            >
              <legend style={{ fontSize: "0.85rem", fontWeight: 550, padding: "0 0.35rem" }}>
                Who can see this shift
              </legend>

              <label style={{ fontWeight: 400, marginBottom: "0.6rem" }}>
                <input
                  type="radio"
                  name="visibility"
                  value="favourites_only"
                  defaultChecked
                  style={{ width: "auto", marginRight: "0.5rem" }}
                />
                My saved locums only
              </label>

              <label style={{ fontWeight: 400, marginBottom: "0.5rem" }}>
                <input
                  type="radio"
                  name="visibility"
                  value="radius"
                  style={{ width: "auto", marginRight: "0.5rem" }}
                />
                Any verified locum within a radius
              </label>

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="radiusKm" className="sr-only">
                  Radius in kilometres
                </label>
                <input
                  id="radiusKm"
                  name="radiusKm"
                  type="number"
                  min="1"
                  max="200"
                  defaultValue={25}
                />
                <p className="hint">Kilometres. Only used for the wider option.</p>
              </div>
            </fieldset>

            <div className="field">
              <label htmlFor="notes">Notes for the locum</label>
              <textarea
                id="notes"
                name="notes"
                maxLength={2000}
                placeholder="Dispensary system, parking, who to ask for on arrival…"
              />
            </div>

            <button type="submit" className="primary">
              Post shift
            </button>
          </form>
        )}
      </main>
    </>
  );
}

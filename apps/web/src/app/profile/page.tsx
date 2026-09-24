import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { PHARMACY_AREA_NAMES } from "@/lib/pharmacy-areas";
import { badgeToneFor } from "@/lib/format";

interface Account {
  email: string;
  fullName: string;
  phone: string | null;
}

interface LocumStatus {
  verification: string;
  sapcNumber: string | null;
  maxTravelKm: number;
}

interface Pharmacy {
  id: string;
  name: string;
  tradingName: string | null;
  addressLine: string;
  suburb: string | null;
  city: string;
  postalCode: string | null;
  verification: string;
  sapcPharmacyNumber: string | null;
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const viewer = await requireRole("locum", "manager");
  const { error, notice } = await searchParams;
  const account = await api.query<Account>("profile.me");

  async function saveAccount(formData: FormData) {
    "use server";
    const fullName = String(formData.get("fullName") ?? "").trim();
    const phone = String(formData.get("phone") ?? "").trim();
    try {
      await api.mutate("profile.updateAccount", {
        fullName,
        ...(phone !== "" && { phone }),
      });
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "Could not save your profile";
      redirect(`/profile?error=${encodeURIComponent(message)}`);
    }
  }

  async function saveLocum(formData: FormData) {
    "use server";
    const fullName = String(formData.get("fullName") ?? "").trim();
    const phone = String(formData.get("phone") ?? "").trim();
    const sapcNumber = String(formData.get("sapcNumber") ?? "").trim();
    const area = String(formData.get("area") ?? "").trim();
    const maxTravelKm = Number(formData.get("maxTravelKm") ?? "25");

    try {
      await api.mutate("profile.updateAccount", {
        fullName,
        ...(phone !== "" && { phone }),
      });
      await api.mutate("profile.updateLocumProfile", {
        sapcNumber,
        area,
        maxTravelKm,
        submitForReview: true,
      });
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "Could not save your profile";
      redirect(`/profile?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/profile");
    revalidatePath("/browse");
    redirect(
      `/profile?notice=${encodeURIComponent(
        "Profile saved. An admin can now verify your SAPC registration.",
      )}`,
    );
  }

  async function savePharmacy(formData: FormData) {
    "use server";
    const pharmacyId = String(formData.get("pharmacyId") ?? "");
    const area = String(formData.get("area") ?? "").trim();
    try {
      await api.mutate("profile.updatePharmacy", {
        pharmacyId,
        name: String(formData.get("name") ?? "").trim(),
        tradingName: String(formData.get("tradingName") ?? "").trim(),
        addressLine: String(formData.get("addressLine") ?? "").trim(),
        suburb: String(formData.get("suburb") ?? "").trim(),
        postalCode: String(formData.get("postalCode") ?? "").trim(),
        ...(area !== "" && { area }),
      });
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "Could not save the pharmacy";
      redirect(`/profile?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/profile");
    redirect(`/profile?notice=${encodeURIComponent("Pharmacy profile saved.")}`);
  }

  const locum =
    viewer.role === "locum" ? await api.query<LocumStatus | null>("verification.myStatus") : null;
  const pharmacies =
    viewer.role === "manager" ? await api.query<Pharmacy[]>("profile.myPharmacies") : [];

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "40rem" }}>
        <h1>Profile</h1>
        <p className="lede">
          {viewer.role === "locum"
            ? "Finish this so an admin can check your SAPC registration. Pharmacies can only confirm verified locums."
            : "Your pharmacy stays unverified until an admin checks its SAPC number."}
        </p>

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

        {viewer.role === "locum" && locum ? (
          <form action={saveLocum} className="card stack">
            <div className="row">
              <strong>Locum registration</strong>
              <span className={badgeToneFor(locum.verification)}>{locum.verification}</span>
            </div>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" value={account.email} readOnly />
            </div>
            <div className="field">
              <label htmlFor="fullName">Full name</label>
              <input
                id="fullName"
                name="fullName"
                required
                minLength={2}
                maxLength={200}
                defaultValue={account.fullName}
              />
            </div>
            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                name="phone"
                type="tel"
                maxLength={20}
                defaultValue={account.phone ?? ""}
                placeholder="+27…"
              />
            </div>
            <div className="field">
              <label htmlFor="sapcNumber">SAPC registration number</label>
              <input
                id="sapcNumber"
                name="sapcNumber"
                required
                minLength={4}
                maxLength={32}
                defaultValue={locum.sapcNumber ?? ""}
              />
            </div>
            <div className="field">
              <label htmlFor="area">Home area</label>
              <select id="area" name="area" required defaultValue="">
                <option value="" disabled>
                  Nearest area you can travel from…
                </option>
                {PHARMACY_AREA_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="maxTravelKm">How far you will travel (km)</label>
              <input
                id="maxTravelKm"
                name="maxTravelKm"
                type="number"
                required
                min={1}
                max={200}
                defaultValue={locum.maxTravelKm}
              />
            </div>
            <button type="submit" className="primary">
              Save and submit for verification
            </button>
          </form>
        ) : null}

        {viewer.role === "manager" ? (
          <div className="stack">
            <form action={saveAccount} className="card stack">
              <strong>Your account</strong>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" value={account.email} readOnly />
              </div>
              <div className="field">
                <label htmlFor="fullName">Full name</label>
                <input
                  id="fullName"
                  name="fullName"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={account.fullName}
                />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  maxLength={20}
                  defaultValue={account.phone ?? ""}
                  placeholder="+27…"
                />
              </div>
              <button type="submit" className="primary">
                Save account
              </button>
            </form>

            {pharmacies.map((pharmacy) => (
              <form key={pharmacy.id} action={savePharmacy} className="card stack">
                <div className="row">
                  <strong>{pharmacy.name}</strong>
                  <span className={badgeToneFor(pharmacy.verification)}>{pharmacy.verification}</span>
                </div>
                <p className="dim" style={{ margin: 0 }}>
                  SAPC pharmacy number:{" "}
                  <strong className="mono">{pharmacy.sapcPharmacyNumber ?? "—"}</strong>
                </p>
                <input type="hidden" name="pharmacyId" value={pharmacy.id} />
                <div className="field">
                  <label htmlFor={`name-${pharmacy.id}`}>Pharmacy name</label>
                  <input
                    id={`name-${pharmacy.id}`}
                    name="name"
                    required
                    minLength={2}
                    maxLength={200}
                    defaultValue={pharmacy.name}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`trading-${pharmacy.id}`}>Trading name</label>
                  <input
                    id={`trading-${pharmacy.id}`}
                    name="tradingName"
                    maxLength={200}
                    defaultValue={pharmacy.tradingName ?? ""}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`address-${pharmacy.id}`}>Address</label>
                  <input
                    id={`address-${pharmacy.id}`}
                    name="addressLine"
                    required
                    minLength={3}
                    maxLength={500}
                    defaultValue={pharmacy.addressLine}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`suburb-${pharmacy.id}`}>Suburb</label>
                  <input
                    id={`suburb-${pharmacy.id}`}
                    name="suburb"
                    maxLength={120}
                    defaultValue={pharmacy.suburb ?? ""}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`postal-${pharmacy.id}`}>Postal code</label>
                  <input
                    id={`postal-${pharmacy.id}`}
                    name="postalCode"
                    maxLength={10}
                    defaultValue={pharmacy.postalCode ?? ""}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`area-${pharmacy.id}`}>Nearest area</label>
                  <select id={`area-${pharmacy.id}`} name="area" defaultValue="">
                    <option value="">Keep the current location</option>
                    {PHARMACY_AREA_NAMES.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="primary">
                  Save pharmacy
                </button>
              </form>
            ))}
          </div>
        ) : null}
      </main>
    </>
  );
}

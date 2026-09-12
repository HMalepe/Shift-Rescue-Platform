import Link from "next/link";
import { redirect } from "next/navigation";
import { register } from "@/lib/api";
import { isSignedIn } from "@/lib/session";
import { PHARMACY_AREA_NAMES } from "@/lib/pharmacy-areas";

export default async function RegisterManagerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isSignedIn()) redirect("/");
  const { error } = await searchParams;

  async function submit(formData: FormData) {
    "use server";

    const result = await register({
      role: "manager",
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      fullName: String(formData.get("fullName") ?? ""),
      pharmacyName: String(formData.get("pharmacyName") ?? ""),
      addressLine: String(formData.get("addressLine") ?? ""),
      area: String(formData.get("area") ?? ""),
      sapcPharmacyNumber: String(formData.get("sapcPharmacyNumber") ?? ""),
    });

    if (!result.ok) {
      redirect(`/register/manager?error=${encodeURIComponent(result.message)}`);
    }

    redirect("/");
  }

  return (
    <main className="shell" style={{ maxWidth: "28rem", paddingTop: "4rem" }}>
      <h1>Pharmacy sign-up</h1>
      <p className="lede">
        You can post shifts right away. Your pharmacy&rsquo;s SAPC registration is
        checked by an admin in the background — nothing here blocks on that.
      </p>

      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <form action={submit} className="card">
        <h2 style={{ marginTop: 0 }}>Your account</h2>
        <div className="field">
          <label htmlFor="fullName">Your name</label>
          <input id="fullName" name="fullName" required minLength={2} maxLength={200} />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="username" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
          />
          <p className="hint">At least 12 characters.</p>
        </div>

        <h2>Pharmacy</h2>
        <div className="field">
          <label htmlFor="pharmacyName">Pharmacy name</label>
          <input id="pharmacyName" name="pharmacyName" required minLength={2} maxLength={200} />
        </div>
        <div className="field">
          <label htmlFor="addressLine">Street address</label>
          <input id="addressLine" name="addressLine" required minLength={3} maxLength={500} />
        </div>
        <div className="field">
          <label htmlFor="area">Nearest area</label>
          <select id="area" name="area" required defaultValue="">
            <option value="" disabled>
              Select the closest area…
            </option>
            {PHARMACY_AREA_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p className="hint">
            Used to find you locums nearby — you can set an exact location later.
          </p>
        </div>
        <div className="field">
          <label htmlFor="sapcPharmacyNumber">Pharmacy&rsquo;s SAPC registration number</label>
          <input
            id="sapcPharmacyNumber"
            name="sapcPharmacyNumber"
            required
            minLength={4}
            maxLength={32}
          />
        </div>

        <button type="submit" className="primary" style={{ width: "100%" }}>
          Create account
        </button>
      </form>

      <p className="hint" style={{ marginTop: "1rem" }}>
        Looking for shifts instead? <Link href="/register/locum">Sign up here</Link>.
      </p>
    </main>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { register } from "@/lib/api";
import { isSignedIn } from "@/lib/session";

export default async function RegisterLocumPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isSignedIn()) redirect("/");
  const { error } = await searchParams;

  async function submit(formData: FormData) {
    "use server";

    const result = await register({
      role: "locum",
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      fullName: String(formData.get("fullName") ?? ""),
      sapcNumber: String(formData.get("sapcNumber") ?? ""),
    });

    if (!result.ok) {
      redirect(`/register/locum?error=${encodeURIComponent(result.message)}`);
    }

    redirect("/");
  }

  return (
    <main className="shell" style={{ maxWidth: "26rem", paddingTop: "4rem" }}>
      <h1>Locum sign-up</h1>
      <p className="lede">
        Your account starts unverified — a Locum Planner admin checks your SAPC
        registration before pharmacies can confirm you for a shift, so browsing works
        immediately but confirmed bookings don&rsquo;t until that&rsquo;s done.
      </p>

      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <form action={submit} className="card">
        <div className="field">
          <label htmlFor="fullName">Full name</label>
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

        <div className="field">
          <label htmlFor="sapcNumber">SAPC registration number</label>
          <input id="sapcNumber" name="sapcNumber" required minLength={4} maxLength={32} />
          <p className="hint">Your own pharmacist registration number, not a pharmacy&rsquo;s.</p>
        </div>

        <button type="submit" className="primary" style={{ width: "100%" }}>
          Create account
        </button>
      </form>

      <p className="hint" style={{ marginTop: "1rem" }}>
        Managing a pharmacy instead? <Link href="/register/manager">Sign up here</Link>.
      </p>
    </main>
  );
}

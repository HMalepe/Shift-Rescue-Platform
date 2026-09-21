import Link from "next/link";
import { redirect } from "next/navigation";
import { api, signIn } from "@/lib/api";
import { isSignedIn } from "@/lib/session";
import { homeFor, type Role } from "@/lib/guard";

/**
 * Sign in.
 *
 * The TOTP field is always present rather than appearing after an
 * `MFA_REQUIRED` round trip. Showing it conditionally would tell an
 * unauthenticated caller which accounts have MFA enabled — which is to say,
 * which accounts are admins — from the login form alone, and admins are
 * exactly the accounts worth attacking (§12.1).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isSignedIn()) {
    try {
      const me = await api.query<
        { authenticated: true; id: string; role: Role } | { authenticated: false }
      >("me");
      if (me.authenticated) redirect(homeFor(me.role));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "digest" in error &&
        typeof (error as { digest?: unknown }).digest === "string" &&
        (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
      ) {
        throw error;
      }
    }
    redirect("/session/clear");
  }
  const { error } = await searchParams;

  async function submit(formData: FormData) {
    "use server";

    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const totpCode = String(formData.get("totpCode") ?? "").trim();

    const result = await signIn({
      email,
      password,
      ...(totpCode !== "" && { totpCode }),
    });

    if (!result.ok) {
      /*
       * The message comes from the API, which returns the same "Invalid email
       * or password" for a wrong password and an unknown address. Rewriting it
       * here to be more helpful would rebuild the account-enumeration oracle
       * the API went out of its way not to be.
       */
      redirect(`/login?error=${encodeURIComponent(result.message)}`);
    }

    redirect("/");
  }

  return (
    <main className="shell" style={{ maxWidth: "24rem", paddingTop: "5rem" }}>
      <h1>Locum Planner</h1>
      <p className="lede">Relief pharmacist cover, Johannesburg and greater Gauteng.</p>

      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <form action={submit} className="card">
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
            autoComplete="current-password"
          />
        </div>

        <div className="field">
          <label htmlFor="totpCode">Authenticator code</label>
          <input
            id="totpCode"
            name="totpCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            placeholder="000000"
          />
          <p className="hint">Only required for admin accounts.</p>
        </div>

        <button type="submit" className="primary" style={{ width: "100%" }}>
          Sign in
        </button>
      </form>

      <p className="hint" style={{ marginTop: "1rem" }}>
        New here? <Link href="/register">Create an account</Link>.
      </p>
    </main>
  );
}

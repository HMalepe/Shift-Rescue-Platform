import Link from "next/link";
import { redirect } from "next/navigation";
import { api, signIn } from "@/lib/api";
import { isSignedIn } from "@/lib/session";
import { PasswordField } from "@/components/PasswordField";
import { homeFor, type Role } from "@/lib/guard";

/** Sign in with email and password. */
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

    const result = await signIn({ email, password });

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

        <PasswordField id="password" autoComplete="current-password" />

        <button type="submit" className="primary" style={{ width: "100%" }}>
          Sign in
        </button>
      </form>

      <p className="hint" style={{ marginTop: "1rem" }}>
        New here? <Link href="/register">Create an account</Link>.
        First admin? <Link href="/setup">Set up here</Link>.
      </p>
    </main>
  );
}

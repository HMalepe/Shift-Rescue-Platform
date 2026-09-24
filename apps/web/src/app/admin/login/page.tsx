import Link from "next/link";
import { redirect } from "next/navigation";
import { api, signIn } from "@/lib/api";
import { isSignedIn } from "@/lib/session";
import { PasswordField } from "@/components/PasswordField";
import type { Role } from "@/lib/guard";

/**
 * Admin sign-in. Separate from the pharmacy and locum screen because the same
 * email can belong to both, with a different password on each.
 *
 * A manager session does not bounce away from this page — signing in here
 * replaces that session with the admin one.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isSignedIn()) {
    try {
      const me = await api.query<
        { authenticated: true; id: string; role: Role } | { authenticated: false }
      >("me");
      if (me.authenticated && me.role === "admin") redirect("/admin");
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
  }
  const { error } = await searchParams;

  async function submit(formData: FormData) {
    "use server";

    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const result = await signIn({ email, password, admin: true });

    if (!result.ok) {
      redirect(`/admin/login?error=${encodeURIComponent(result.message)}`);
    }

    redirect("/admin");
  }

  return (
    <main className="shell" style={{ maxWidth: "24rem", paddingTop: "5rem" }}>
      <h1>Admin sign in</h1>
      <p className="lede">
        This is separate from a pharmacy or locum account, even when they share an email.
      </p>

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

        <PasswordField id="admin-password" autoComplete="current-password" />

        <button type="submit" className="primary" style={{ width: "100%" }}>
          Sign in
        </button>
      </form>

      <p className="hint" style={{ marginTop: "1rem" }}>
        Pharmacy or locum? <Link href="/login">Sign in here</Link>.
        First time? <Link href="/setup">Set the admin password</Link>.
      </p>
    </main>
  );
}

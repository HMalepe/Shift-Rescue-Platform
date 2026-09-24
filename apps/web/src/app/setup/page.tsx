import Link from "next/link";
import { fetchSetupStatus } from "@/lib/api";
import { readAdminEnv } from "@/lib/admin-env";
import { SetupForm } from "./setup-form";

export default async function SetupPage() {
  const admin = readAdminEnv();
  const { available } = await fetchSetupStatus();

  return (
    <main className="shell" style={{ maxWidth: "26rem", paddingTop: "5rem" }}>
      <h1>First admin</h1>
      {!admin.configured ? (
        <p className="lede">
          In Vercel → Settings → Environment Variables (Production), set{" "}
          <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code> (at least 12
          characters). Redeploy, then come back here.
        </p>
      ) : !available ? (
        <p className="lede">
          Admin setup is closed. <Link href="/login">Sign in</Link> with{" "}
          <strong>{admin.email}</strong> or{" "}
          <Link href="/register">create a locum or pharmacy account</Link>.
        </p>
      ) : (
        <>
          <p className="lede">
            One account, once. After this, sign in with the email and password from
            Vercel.
          </p>
          <SetupForm email={admin.email} />
        </>
      )}
    </main>
  );
}

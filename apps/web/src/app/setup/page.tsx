import { fetchSetupStatus } from "@/lib/api";
import { readAdminEnv } from "@/lib/admin-env";
import { PasswordForm } from "./setup-form";

export default async function SetupPage() {
  const admin = readAdminEnv();
  const { available } = await fetchSetupStatus();

  return (
    <main className="shell" style={{ maxWidth: "26rem", paddingTop: "5rem" }}>
      <h1>First admin</h1>
      {!admin.configured ? (
        <p className="lede">
          In Vercel → Settings → Environment Variables (Production), set{" "}
          <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code>. Redeploy, then
          come back here.
        </p>
      ) : available ? (
        <>
          <p className="lede">
            One account, once. After this, sign in with the email and password from
            Vercel.
          </p>
          <PasswordForm email={admin.email} mode="create" />
        </>
      ) : (
        <>
          <p className="lede">
            <strong>{admin.email}</strong> can also be a pharmacy account. This
            saves <code>ADMIN_PASSWORD</code> on a separate admin sign-in.
          </p>
          <PasswordForm email={admin.email} mode="reset" />
        </>
      )}
    </main>
  );
}

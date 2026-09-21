import Link from "next/link";
import { fetchSetupStatus } from "@/lib/api";
import { SetupForm } from "./setup-form";

export default async function SetupPage() {
  const { available } = await fetchSetupStatus();

  return (
    <main className="shell" style={{ maxWidth: "26rem", paddingTop: "5rem" }}>
      <h1>First admin</h1>
      {available ? (
        <>
          <p className="lede">
            One account, once. After this, sign in with an authenticator code — there is
            no self-serve admin signup.
          </p>
          <SetupForm />
        </>
      ) : (
        <p className="lede">
          Admin setup is closed. <Link href="/login">Sign in</Link> or{" "}
          <Link href="/register">create a locum or pharmacy account</Link>.
        </p>
      )}
    </main>
  );
}

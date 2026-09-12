import Link from "next/link";
import { redirect } from "next/navigation";
import { isSignedIn } from "@/lib/session";

/**
 * Role choice before the actual form.
 *
 * A single form with a role toggle would need client-side JS just to show
 * and hide the two very different field sets (a locum's SAPC number vs. a
 * manager's whole pharmacy). Splitting into two pages keeps every page in
 * this app a plain server-rendered form, no exception.
 */
export default async function RegisterChoicePage() {
  if (await isSignedIn()) redirect("/");

  return (
    <main className="shell" style={{ maxWidth: "34rem", paddingTop: "5rem" }}>
      <h1>Create an account</h1>
      <p className="lede">Which describes you?</p>

      <div className="stack">
        <Link href="/register/locum" className="card" style={{ display: "block" }}>
          <strong>I&rsquo;m a locum</strong>
          <p className="dim" style={{ margin: "0.3rem 0 0" }}>
            Looking for relief pharmacist shifts.
          </p>
        </Link>
        <Link href="/register/manager" className="card" style={{ display: "block" }}>
          <strong>I manage a pharmacy</strong>
          <p className="dim" style={{ margin: "0.3rem 0 0" }}>
            Looking to post shifts and find cover.
          </p>
        </Link>
      </div>

      <p className="hint" style={{ marginTop: "1.5rem" }}>
        Already have an account? <Link href="/login">Sign in</Link>.
      </p>
    </main>
  );
}

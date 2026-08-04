import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { requireViewer } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { signOut } from "@/lib/api";

/**
 * §10 — the subject's own privacy page.
 *
 * Two things are said here that a compliance page usually does not say, and
 * both are said because they are true.
 *
 * Erasure is described as anonymisation, not disappearance. Bookings, invoices
 * and attendance times survive, because they are also the pharmacy's records
 * and are held under a legal obligation. Promising deletion and performing
 * anonymisation is the more common choice and it is a lie the subject cannot
 * check.
 *
 * The no-show retention is stated plainly rather than buried. Someone
 * considering erasure partly to shed a bad record deserves to know it will not
 * work, before they irreversibly destroy their own account for nothing.
 */
export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const viewer = await requireViewer();
  const { error } = await searchParams;

  async function download() {
    "use server";
    // Rendered as JSON on a page rather than pushed as a file: the export
    // contains personal data, and a file that lands in a downloads folder
    // outlives the moment someone wanted to look at it.
    redirect("/privacy/export");
  }

  async function erase(formData: FormData) {
    "use server";
    const confirmation = String(formData.get("confirmation") ?? "");

    try {
      await api.mutate("privacy.eraseMine", { confirmation });
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : "Could not erase your account";
      redirect(`/privacy?error=${encodeURIComponent(message)}`);
    }

    // The session is dead by construction — sessionsValidFrom moved past it.
    // Clearing the cookies avoids a confusing bounce through a 401.
    await signOut();
    redirect("/login");
  }

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "42rem" }}>
        <h1>Your data</h1>
        <p className="lede">
          What Locum Planner holds about you, and how to have it removed.
        </p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="card" style={{ marginBottom: "1.5rem" }}>
          <h2 style={{ marginTop: 0 }}>Get a copy</h2>
          <p className="dim">
            Everything held about you across every table — your profile, bookings,
            the location recorded at each check-in, messages you sent, and every
            decision made about your verification.
          </p>
          <p className="hint">
            Your password and authenticator secret are not included. Returning them
            would turn a data request into a way of stealing an account.
          </p>
          <form action={download}>
            <button type="submit" className="primary">
              View my data
            </button>
          </form>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Erase your account</h2>
          <p className="dim">
            Your name, phone number, documents, location history and message
            contents are removed. This cannot be undone, and no administrator can
            recover it afterwards.
          </p>

          <p className="alert alert-note">
            <strong>What is kept, and why.</strong> A record that each shift was
            worked stays with the pharmacy — it needs that for its own compliance,
            and the invoices it has already paid cannot be altered. Check-in{" "}
            <em>times</em> are kept for the same reason; the GPS coordinates are
            not.
          </p>

          <p className="alert alert-note">
            <strong>Your shift history is not reset.</strong> Counts of completed
            shifts and no-shows survive erasure, attached to no name. If you are
            hoping erasure will clear a poor record so you can start again, it will
            not — and you would be destroying your account for nothing.
          </p>

          <form action={erase}>
            <div className="field">
              <label htmlFor="confirmation">
                Type <span className="mono">ERASE MY ACCOUNT</span> to confirm
              </label>
              <input id="confirmation" name="confirmation" autoComplete="off" required />
            </div>
            <button type="submit">Erase my account permanently</button>
          </form>
        </section>
      </main>
    </>
  );
}

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireViewer } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";

/**
 * §11.4 — the WhatsApp opt-out surface.
 *
 * Locum Planner sends WhatsApp notifications from a number that is send-only
 * for this product (see docs/PRODUCT_TECH_SPEC.md §11.1's addendum) — texting
 * STOP does nothing here, because inbound on that number goes to a different
 * bot entirely. This page is the actual opt-out mechanism: a link, consistent
 * with every other notification this product sends, which is itself a link to
 * click rather than a message to reply to.
 */

interface Profile {
  readonly whatsappOptInAt: string | null;
  readonly whatsappOptOutAt: string | null;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const viewer = await requireViewer();
  const { error } = await searchParams;
  const profile = await api.query<Profile>("profile.me");

  const optedIn =
    profile.whatsappOptInAt !== null &&
    (profile.whatsappOptOutAt === null ||
      new Date(profile.whatsappOptOutAt) < new Date(profile.whatsappOptInAt));

  async function setConsent(formData: FormData) {
    "use server";
    const optIn = formData.get("optIn") === "true";

    try {
      await api.mutate("profile.setWhatsappConsent", { optIn });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not update your preference";
      redirect(`/settings?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/settings");
  }

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "42rem" }}>
        <h1>Notification settings</h1>
        <p className="lede">How Locum Planner reaches you.</p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="card">
          <h2 style={{ marginTop: 0 }}>WhatsApp notifications</h2>
          <p className="dim">
            Shift offers, booking confirmations and other account updates, sent as
            WhatsApp messages with a link back here. This is a notification channel
            only — replying on WhatsApp does not reach Locum Planner, so use this
            page (or the link in the message) to turn notifications off.
          </p>

          <p>
            Currently: <strong>{optedIn ? "On" : "Off"}</strong>
          </p>

          <form action={setConsent}>
            <input type="hidden" name="optIn" value={optedIn ? "false" : "true"} />
            <button type="submit" className={optedIn ? "" : "primary"}>
              {optedIn ? "Turn off WhatsApp notifications" : "Turn on WhatsApp notifications"}
            </button>
          </form>
        </section>
      </main>
    </>
  );
}

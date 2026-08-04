import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";

interface Pharmacy {
  id: string;
  name: string;
  suburb: string | null;
  city: string;
}

/**
 * §2 — starts the Payfast Subscribe flow.
 *
 * This page only ever gets a manager as far as Payfast's hosted checkout.
 * Nothing here marks a subscription active — that is the ITN webhook's job,
 * once Payfast confirms payment server-to-server. A manager who pays and
 * closes the tab before the ITN lands still ends up subscribed; one who never
 * pays never does, regardless of what happens on this page.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const viewer = await requireRole("manager");
  const [pharmacies, { error }] = await Promise.all([
    api.query<Pharmacy[]>("profile.myPharmacies"),
    searchParams,
  ]);

  async function subscribe(formData: FormData) {
    "use server";

    const pharmacyId = String(formData.get("pharmacyId") ?? "");

    let redirectFields: { url: string; fields: Array<[string, string]> };
    try {
      redirectFields = await api.mutate<{ url: string; fields: Array<[string, string]> }>(
        "billing.subscribe",
        { pharmacyId },
      );
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not start checkout";
      redirect(`/billing?error=${encodeURIComponent(message)}`);
    }

    redirect(
      `/billing/checkout?url=${encodeURIComponent(redirectFields.url)}&fields=${encodeURIComponent(
        JSON.stringify(redirectFields.fields),
      )}`,
    );
  }

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "38rem" }}>
        <h1>Billing</h1>
        <p className="lede">
          A flat monthly subscription covers Locum Planner. Locum wages are paid by
          your pharmacy directly — the platform never touches that money.
        </p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        {pharmacies.length === 0 ? (
          <p className="empty">
            Your account is not linked to a pharmacy yet. An administrator needs to add
            you before you can subscribe.
          </p>
        ) : (
          pharmacies.map((pharmacy) => (
            <form key={pharmacy.id} action={subscribe} className="card">
              <input type="hidden" name="pharmacyId" value={pharmacy.id} />
              <h2 style={{ marginTop: 0 }}>{pharmacy.name}</h2>
              <p className="hint">
                {pharmacy.suburb ? `${pharmacy.suburb}, ` : ""}
                {pharmacy.city}
              </p>
              <button type="submit" className="primary">
                Subscribe with Payfast
              </button>
            </form>
          ))
        )}
      </main>
    </>
  );
}

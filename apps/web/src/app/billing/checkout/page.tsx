import { redirect } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { AutoSubmitForm } from "@/components/AutoSubmitForm";

/**
 * Hands the browser off to Payfast's hosted checkout.
 *
 * Nothing here is secret: `fields` is exactly what is about to be POSTed to
 * Payfast, and Payfast's own signature (computed server-side with the
 * passphrase, which never appears in these fields) is what makes the request
 * trustworthy — not the URL being opaque.
 */
export default async function BillingCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; fields?: string }>;
}) {
  await requireRole("manager");
  const { url, fields } = await searchParams;

  if (!url || !fields) {
    redirect("/billing?error=Could%20not%20start%20checkout");
  }

  let parsed: Array<[string, string]>;
  try {
    parsed = JSON.parse(fields) as Array<[string, string]>;
  } catch {
    redirect("/billing?error=Could%20not%20start%20checkout");
  }

  return (
    <main className="shell" style={{ maxWidth: "38rem" }}>
      <h1>Redirecting to Payfast…</h1>
      <p className="lede">Do not close this page.</p>
      <AutoSubmitForm url={url} fields={parsed} />
    </main>
  );
}

import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";

/**
 * Where Payfast sends the browser back after a successful checkout.
 *
 * This page does not activate anything — that only happens once the ITN
 * postback confirms payment server-to-server (see
 * apps/api/src/payfast/itn-webhook.ts). The ITN can arrive before or after
 * this page loads, so the wording here is deliberately non-committal about
 * whether billing is active yet.
 */
export default async function BillingReturnPage() {
  const viewer = await requireRole("manager");

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "38rem" }}>
        <h1>Thanks — payment received</h1>
        <p className="lede">
          We&apos;re confirming your subscription with Payfast now. This usually takes a
          few seconds and does not need a refresh.
        </p>
        <Link href="/billing">Back to billing</Link>
      </main>
    </>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { BILLING_ENABLED } from "@/lib/billing";

/** Where Payfast sends the browser back if the manager cancels checkout. */
export default async function BillingCancelPage() {
  if (!BILLING_ENABLED) redirect("/shifts");

  const viewer = await requireRole("manager");

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "38rem" }}>
        <h1>Checkout cancelled</h1>
        <p className="lede">Nothing was charged. You can try again any time.</p>
        <Link href="/billing">Back to billing</Link>
      </main>
    </>
  );
}

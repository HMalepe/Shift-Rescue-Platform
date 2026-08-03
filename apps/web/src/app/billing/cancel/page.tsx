import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";

/** Where Payfast sends the browser back if the manager cancels checkout. */
export default async function BillingCancelPage() {
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

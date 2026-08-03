import Link from "next/link";
import { signOut } from "@/lib/api";
import { redirect } from "next/navigation";
import type { Role } from "@/lib/guard";

/**
 * Sign-out is a Server Action on a POST form, not a link.
 *
 * A GET link that ends a session can be triggered by anything that fetches
 * URLs — a link prefetcher, an email scanner, an image tag on another site —
 * and the user is simply logged out with no idea why. Server Actions also
 * carry Next's origin check, so this cannot be driven cross-site.
 */
async function signOutAction() {
  "use server";
  await signOut();
  redirect("/login");
}

const NAV: Record<Role, ReadonlyArray<{ href: string; label: string }>> = {
  manager: [
    { href: "/shifts", label: "Shifts" },
    { href: "/shifts/new", label: "Post a shift" },
    { href: "/billing", label: "Billing" },
  ],
  locum: [
    { href: "/browse", label: "Find shifts" },
    { href: "/bookings", label: "My bookings" },
  ],
  admin: [
    { href: "/admin/dashboard", label: "Operations" },
    { href: "/admin/verification", label: "Verification" },
    { href: "/admin/flagged", label: "Flagged messages" },
  ],
};

export function Masthead({ role }: { role: Role }) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <Link href="/" className="wordmark">
          Locum Planner
        </Link>
        <nav className="navlinks">
          {NAV[role].map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
          {/* §10 — reachable from every page, for every role. A privacy
              right behind a support email is a right most people never
              exercise. */}
          <Link href="/privacy">Your data</Link>
          <form action={signOutAction}>
            <button type="submit" className="quiet">
              Sign out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}

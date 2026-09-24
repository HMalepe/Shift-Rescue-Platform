"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { signOutAction } from "@/lib/actions";
import type { Role } from "@/lib/guard";
import { BILLING_ENABLED } from "@/lib/billing";

const NAV: Record<Role, ReadonlyArray<{ href: string; label: string }>> = {
  manager: [
    { href: "/shifts", label: "Shifts" },
    { href: "/shifts/new", label: "Post a shift" },
    // Phase 1 charges nobody — see lib/billing.ts. Nothing links to /billing
    // at all until BILLING_ENABLED is on.
    ...(BILLING_ENABLED ? [{ href: "/billing", label: "Billing" }] : []),
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

/** What shows next to the wordmark, so the same person switching between a
 *  manager and a locum login (or an admin checking in) never has to guess
 *  which dashboard they landed on. */
const ROLE_LABEL: Record<Role, string> = {
  manager: "Manager",
  locum: "Locum",
  admin: "Admin",
};

/**
 * Marks exactly one nav item active, even when hrefs nest ("/shifts" and
 * "/shifts/new" both prefix-match a "/shifts/new" pathname) — the longest
 * matching href wins rather than every ancestor lighting up at once.
 */
function isActive(pathname: string, href: string, allHrefs: readonly string[]): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  return !allHrefs.some(
    (other) =>
      other !== href &&
      other.length > href.length &&
      (pathname === other || pathname.startsWith(`${other}/`)),
  );
}

export function Masthead({ role }: { role: Role }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items = NAV[role];
  const hrefs = items.map((item) => item.href);

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <Link href="/" className="wordmark">
          Locum Planner
        </Link>
        <span className={`badge badge-role badge-role-${role}`}>{ROLE_LABEL[role]}</span>

        <button
          type="button"
          className="quiet nav-toggle"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="sr-only">Menu</span>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>

        <nav id="primary-nav" className={`navlinks${open ? " nav-open" : ""}`}>
          {items.map((item) => {
            const active = isActive(pathname, item.href, hrefs);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={active ? "active" : undefined}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            );
          })}
          {/* §11.4 — the WhatsApp opt-out. Reachable from every page for the
              same reason /privacy is: a right behind a support email is a
              right most people never exercise, and this number is send-only,
              so a web link is the only opt-out that exists. */}
          <Link href="/settings" onClick={() => setOpen(false)}>
            Notifications
          </Link>
          {/* §10 — reachable from every page, for every role. A privacy
              right behind a support email is a right most people never
              exercise. */}
          <Link href="/privacy" onClick={() => setOpen(false)}>
            Your data
          </Link>
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

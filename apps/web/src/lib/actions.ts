"use server";

import { redirect } from "next/navigation";
import { signOut } from "@/lib/api";

/**
 * Sign-out is a Server Action on a POST form, not a link.
 *
 * A GET link that ends a session can be triggered by anything that fetches
 * URLs — a link prefetcher, an email scanner, an image tag on another site —
 * and the user is simply logged out with no idea why. Server Actions also
 * carry Next's origin check, so this cannot be driven cross-site.
 *
 * Lives in its own "use server" file (rather than inline in Masthead) so the
 * client-side Masthead — which needs `usePathname()` for nav highlighting —
 * can import it directly; a Client Component cannot declare a Server Action
 * inline, only import one.
 */
export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}

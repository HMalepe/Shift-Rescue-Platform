import "server-only";
import { redirect } from "next/navigation";
import { api, UnauthenticatedError } from "./api";
import { clearTokens, readTokens } from "./session";

export type Role = "locum" | "manager" | "admin";

export interface Viewer {
  readonly id: string;
  readonly role: Role;
}

/**
 * Resolves the caller, or sends them to sign in.
 *
 * The role comes from the API on every request rather than from the cookie.
 * The access token carries a role claim, but the API deliberately reads the
 * role from the database instead (see `createContext`) so a demoted admin
 * loses authority immediately. Trusting a cached role here would put that
 * window straight back — the UI would keep offering admin actions the API then
 * refuses, which reads as a broken app rather than a revoked permission.
 *
 * This is a *navigation* guard, not a security boundary. Every procedure
 * behind it re-checks authorization server-side; if this file were deleted the
 * app would be ugly, not insecure.
 */
export async function requireViewer(): Promise<Viewer> {
  const { accessToken, refreshToken } = await readTokens();
  if (!accessToken && !refreshToken) redirect("/login");

  try {
    const me = await api.query<
      { authenticated: true; id: string; role: Role } | { authenticated: false }
    >("me");

    if (!me.authenticated) {
      await clearTokens();
      redirect("/login");
    }
    return { id: me.id, role: me.role };
  } catch (error) {
    await clearTokens();
    if (error instanceof UnauthenticatedError) redirect("/login");
    redirect("/login");
  }
}

export async function requireRole(...allowed: Role[]): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!allowed.includes(viewer.role)) {
    // Sent home rather than shown a 403. Someone landing on the wrong
    // dashboard has almost always followed a stale link, not attempted an
    // escalation, and the API would refuse them anyway.
    redirect("/");
  }
  return viewer;
}

/** Where each role's work actually lives. */
export function homeFor(role: Role): string {
  if (role === "manager") return "/shifts";
  if (role === "admin") return "/admin";
  return "/browse";
}

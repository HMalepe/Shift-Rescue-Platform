import "server-only";

/**
 * First admin credentials. Set on Vercel (Production), never NEXT_PUBLIC_ —
 * these must not land in the browser bundle.
 */
export function readAdminEnv():
  | { configured: false }
  | { configured: true; email: string; password: string; fullName: string } {
  const email = process.env["ADMIN_EMAIL"]?.trim() ?? "";
  const password = process.env["ADMIN_PASSWORD"] ?? "";
  const fullName = process.env["ADMIN_FULL_NAME"]?.trim() || "Admin";

  if (email === "" || password.length < 12) {
    return { configured: false };
  }

  return { configured: true, email, password, fullName };
}

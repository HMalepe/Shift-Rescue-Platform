import "server-only";
import { cookies } from "next/headers";

/**
 * Session handling for the web client.
 *
 * ## Why the browser never sees a token
 *
 * The API authenticates with a Bearer access token and a rotating refresh
 * token (§12.1). The obvious web implementation keeps those in `localStorage`
 * and attaches them from client-side fetch — and it is wrong, because
 * `localStorage` is readable by any script that ends up on the page. A single
 * XSS then yields a refresh token, which is a *long-lived* credential; the
 * rotation and reuse-detection built into the API buy nothing if the attacker
 * gets to rotate it themselves.
 *
 * So this app is a back-end-for-front-end. Tokens live in `httpOnly` cookies
 * that JavaScript cannot read, every API call is made from the Next.js server,
 * and the browser holds a session it can use but cannot exfiltrate. The
 * practical consequence is that almost everything here is a Server Component
 * or a Server Action — which is also why this app ships very little client
 * JavaScript.
 *
 * ## Cookie choices
 *
 * `sameSite: "lax"` rather than `"strict"`: strict would drop the session
 * cookie on a top-level navigation from an external link, so a manager
 * following "you have a new applicant" from a WhatsApp message would land on
 * a login page despite being signed in. Lax still blocks the cross-site POST
 * that CSRF needs, and Server Actions carry their own origin check on top.
 */

const ACCESS_COOKIE = "lp_at";
const REFRESH_COOKIE = "lp_rt";

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires, as reported by the API. */
  readonly expiresIn?: number;
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Off in development so the app works over plain http on localhost; on
    // everywhere else, because a session cookie sent in the clear is not a
    // session cookie.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export async function storeTokens(tokens: Tokens): Promise<void> {
  const jar = await cookies();
  /*
   * The access cookie deliberately outlives the token inside it. Expiring the
   * cookie exactly when the token does would leave a request with no
   * credential at all, and the refresh path below can only act on a token it
   * can still read — a stale access token is what tells us *whose* session to
   * refresh.
   */
  jar.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(60 * 60 * 24 * 30));
  jar.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(60 * 60 * 24 * 30));
}

export async function clearTokens(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

export async function readTokens(): Promise<{
  accessToken: string | undefined;
  refreshToken: string | undefined;
}> {
  const jar = await cookies();
  return {
    accessToken: jar.get(ACCESS_COOKIE)?.value,
    refreshToken: jar.get(REFRESH_COOKIE)?.value,
  };
}

export async function isSignedIn(): Promise<boolean> {
  const { refreshToken } = await readTokens();
  return refreshToken !== undefined;
}

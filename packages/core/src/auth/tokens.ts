import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { UserRole } from "@locum/db";

/**
 * Access tokens: compact, signed, short-lived.
 *
 * Written directly rather than pulling a JWT library. The format is a
 * deliberately small subset — HMAC-SHA256 only, no `alg` negotiation — which
 * structurally removes the `alg: none` and RS256-to-HS256 confusion attacks
 * that a general-purpose JWT verifier has to defend against. There is exactly
 * one algorithm and it is not read from the token.
 */

export interface AccessTokenClaims {
  /** User id. */
  readonly sub: string;
  readonly role: UserRole;
  /** Issued-at, epoch seconds. Compared against users.sessions_valid_from. */
  readonly iat: number;
  /** Expiry, epoch seconds. */
  readonly exp: number;
  /** Session this token belongs to, so a revoked session kills its access tokens. */
  readonly sid: string;
  /** Whether MFA was satisfied. Admin routes require this (§12.1). */
  readonly mfa: boolean;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signAccessToken(claims: AccessTokenClaims, secret: string): string {
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(payload).digest();
  return `${payload}.${base64url(signature)}`;
}

export type AccessTokenResult =
  | { readonly valid: true; readonly claims: AccessTokenClaims }
  | { readonly valid: false; readonly reason: "malformed" | "bad_signature" | "expired" };

export function verifyAccessToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AccessTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };

  const [payload, providedSignature] = parts as [string, string];

  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = fromBase64url(providedSignature);

  // Signature is checked BEFORE the payload is parsed. Parsing first would run
  // JSON.parse over attacker-controlled bytes on every request.
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return { valid: false, reason: "bad_signature" };
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(fromBase64url(payload).toString("utf8")) as AccessTokenClaims;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, claims };
}

/**
 * Refresh tokens are opaque random bytes, not signed claims.
 *
 * 256 bits from the CSPRNG. There is nothing to decode and nothing to forge:
 * validity is decided solely by whether the hash exists in `sessions` and is
 * still live, which is what makes instant revocation possible.
 */
export function generateRefreshToken(): string {
  return base64url(randomBytes(32));
}

/**
 * Only the hash is ever persisted, so a database dump cannot be replayed as a
 * set of live sessions.
 *
 * Plain SHA-256 rather than Argon2 is correct here, and the reason is worth
 * stating: this input is 256 bits of uniform randomness, not a
 * human-guessable secret. There is no dictionary to attack, so the slow-hash
 * cost would buy nothing while adding latency to every refresh.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

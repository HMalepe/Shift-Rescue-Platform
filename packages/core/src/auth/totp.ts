import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) for admin MFA.
 *
 * §12.1 singles admin accounts out: "an admin account with the power to mark
 * employment 'verified' is a high-value target; require MFA on all admin
 * accounts". A compromised admin can forge the platform's core promise — that
 * a pharmacist's SAPC registration was actually checked — so password-only
 * auth is not sufficient for that tier.
 *
 * Implemented directly rather than via a dependency: RFC 6238 is HMAC over a
 * counter plus dynamic truncation, it is stable, and it works with every
 * standard authenticator app.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Accepts codes from the adjacent windows as well as the current one.
 *
 * ±1 window (90 seconds total) absorbs clock drift between the server and the
 * user's phone, which is the single largest source of "my code doesn't work"
 * support load. Widening it further would meaningfully extend the replay
 * window for a shoulder-surfed code, so it stops at one.
 */
const WINDOW_TOLERANCE = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Generates a base32 secret suitable for an authenticator app QR code. */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Computes the TOTP code for a given counter (time step). */
export function generateTotpForCounter(secret: string, counter: number): string {
  const key = base32Decode(secret);

  // Counter as a big-endian 64-bit integer.
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", key).update(counterBuffer).digest();

  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte selects
  // the 4-byte window to read, so the code depends on the whole digest.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function generateTotp(
  secret: string,
  atMs: number = Date.now(),
): string {
  return generateTotpForCounter(
    secret,
    Math.floor(atMs / 1000 / PERIOD_SECONDS),
  );
}

/**
 * Checks a submitted code against the current and adjacent time windows and
 * returns the counter it matched, or `undefined` if none did.
 *
 * The comparison is constant-time. A six-digit code is small enough that a
 * timing side channel plus the ±1 window would meaningfully narrow the search
 * space, and the cost of doing it properly is nil.
 *
 * Returning the counter (rather than a bare boolean) is what lets a caller
 * enforce single-use: a code is a fixed function of its time step, so
 * knowing WHICH step matched is what makes a replay of that exact code
 * detectable, without penalising a caller who simply asks again 30 seconds
 * later and lands on a different counter.
 */
export function matchedTotpCounter(
  secret: string,
  code: string,
  atMs: number = Date.now(),
): number | undefined {
  const submitted = code.trim();
  if (!/^\d{6}$/.test(submitted)) return undefined;

  const currentCounter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  const submittedBuffer = Buffer.from(submitted, "utf8");

  let matched: number | undefined;
  for (
    let counter = currentCounter - WINDOW_TOLERANCE;
    counter <= currentCounter + WINDOW_TOLERANCE;
    counter += 1
  ) {
    let expected: string;
    try {
      expected = generateTotpForCounter(secret, counter);
    } catch {
      return undefined;
    }
    const expectedBuffer = Buffer.from(expected, "utf8");
    // No early exit: every window is compared so total time does not reveal
    // which one matched.
    if (
      expectedBuffer.length === submittedBuffer.length &&
      timingSafeEqual(expectedBuffer, submittedBuffer)
    ) {
      matched = counter;
    }
  }
  return matched;
}

/** Whether a submitted code matches any window. See `matchedTotpCounter`. */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number = Date.now(),
): boolean {
  return matchedTotpCounter(secret, code, atMs) !== undefined;
}

/** otpauth:// URI for provisioning via QR code. */
export function totpProvisioningUri(
  secret: string,
  accountEmail: string,
  issuer = "Locum Planner",
): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

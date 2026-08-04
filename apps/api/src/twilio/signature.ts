import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validates Twilio's `X-Twilio-Signature` header.
 *
 * The webhook is a public, unauthenticated-by-default endpoint that writes to
 * `whatsapp_message_log` and drives §11.6 spend accounting. Without this check
 * anyone who learns the URL can forge delivery receipts — inflating reported
 * delivery rates, corrupting the WhatsApp-vs-push comparison the marketing
 * plan depends on, and (via the inbound handler) injecting messages that look
 * like they came from a real pharmacist.
 *
 * Twilio's scheme, reimplemented here rather than pulled from the `twilio` SDK
 * so the webhook path carries no dependency on a large client library it
 * otherwise does not need:
 *
 *   1. Start with the full request URL, including any query string.
 *   2. For form-encoded POSTs, append every parameter sorted by key, as
 *      `key + value` with no separators.
 *   3. HMAC-SHA1 the result with the account auth token.
 *   4. Base64-encode, and compare against the header.
 *
 * Sorting is by raw key, which is what Twilio does; sorting by anything else
 * produces a valid-looking signature that never matches.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  const sortedKeys = Object.keys(params).sort();
  const payload = sortedKeys.reduce(
    (acc, key) => acc + key + (params[key] ?? ""),
    url,
  );
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

export function isValidTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
  providedSignature: string | undefined,
): boolean {
  if (!providedSignature) return false;

  const expected = computeTwilioSignature(authToken, url, params);

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(providedSignature, "utf8");

  /*
   * Length must be checked before timingSafeEqual, which throws on a mismatch
   * rather than returning false. Comparing lengths first leaks only the length
   * of the signature, which is fixed and public anyway.
   *
   * The comparison itself must be constant-time: a plain === returns as soon
   * as it finds a differing byte, and that timing difference is enough to
   * recover a valid signature one byte at a time.
   */
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

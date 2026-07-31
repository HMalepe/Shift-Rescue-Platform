import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Expiring signed URLs for document retrieval.
 *
 * §12.1: "ensure signed URLs for retrieval expire rather than granting
 * permanent public access to documents containing personal/employment data".
 *
 * The documents in question are SAPC certificates, ID documents and payslips.
 * A URL that never expires is functionally a public link to someone's identity
 * document the moment it appears in a log, a screenshot, a support ticket or a
 * browser history — which is a POPIA problem (§10) well before it is a
 * security one.
 *
 * Implemented here rather than relying solely on S3 presigning so the rule is
 * enforced by our own code and testable without a cloud account. When the S3
 * adapter lands it presigns as well; both must expire.
 */

export interface SignedUrlClaims {
  readonly documentId: string;
  /** Who the URL was issued to. Bound in so a leaked link is not universal. */
  readonly issuedTo: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export type SignedUrlVerification =
  | { readonly valid: true; readonly claims: SignedUrlClaims }
  | {
      readonly valid: false;
      readonly reason: "malformed" | "bad_signature" | "expired" | "wrong_recipient";
    };

/** Five minutes: long enough to render a PDF, short enough to be useless later. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

function payload(claims: SignedUrlClaims): string {
  return `${claims.documentId}:${claims.issuedTo}:${claims.expiresAt}`;
}

export function signDocumentUrl(
  claims: SignedUrlClaims,
  secret: string,
): string {
  const signature = createHmac("sha256", secret)
    .update(payload(claims))
    .digest("base64url");

  const params = new URLSearchParams({
    to: claims.issuedTo,
    expires: String(claims.expiresAt),
    sig: signature,
  });
  return `/documents/${claims.documentId}?${params.toString()}`;
}

export function createSignedUrl(
  documentId: string,
  issuedTo: string,
  secret: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): { readonly url: string; readonly expiresAt: Date } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return {
    url: signDocumentUrl({ documentId, issuedTo, expiresAt }, secret),
    expiresAt: new Date(expiresAt * 1000),
  };
}

export function verifySignedUrl(
  params: {
    readonly documentId: string;
    readonly to: string | undefined;
    readonly expires: string | undefined;
    readonly sig: string | undefined;
  },
  secret: string,
  /** Who is actually presenting the URL, for the recipient binding. */
  presentedBy: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignedUrlVerification {
  if (!params.to || !params.expires || !params.sig) {
    return { valid: false, reason: "malformed" };
  }

  const expiresAt = Number(params.expires);
  if (!Number.isInteger(expiresAt)) {
    return { valid: false, reason: "malformed" };
  }

  const claims: SignedUrlClaims = {
    documentId: params.documentId,
    issuedTo: params.to,
    expiresAt,
  };

  const expected = createHmac("sha256", secret)
    .update(payload(claims))
    .digest("base64url");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(params.sig, "utf8");

  /*
   * Signature before expiry, and constant-time.
   *
   * Checking expiry first would let an attacker distinguish "correctly signed
   * but stale" from "forged", which tells them their forgery attempt is on the
   * right track. Both failures should look identical from outside.
   */
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return { valid: false, reason: "bad_signature" };
  }

  if (expiresAt <= nowSeconds) {
    return { valid: false, reason: "expired" };
  }

  /*
   * Recipient binding. A signed URL that works for anyone holding it is a
   * bearer token for someone's ID document; binding it to the user it was
   * issued to means a link pasted into a shared channel is inert for everyone
   * else.
   */
  if (params.to !== presentedBy) {
    return { valid: false, reason: "wrong_recipient" };
  }

  return { valid: true, claims };
}

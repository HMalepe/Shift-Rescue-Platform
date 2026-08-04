/**
 * Server-side file-type detection from magic bytes.
 *
 * §12.1: "validate file type/size server-side". The emphasis on *server-side*
 * matters — the browser's `Content-Type` and the filename extension are both
 * attacker-controlled, so a `.pdf` claiming `application/pdf` tells you
 * nothing about what the bytes actually are.
 *
 * §14 requires a "disguised executable" fixture specifically, which is this
 * check's reason for existing: an ELF or PE binary renamed to
 * `sapc-certificate.pdf` sails past any extension check.
 */

export type AllowedMimeType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type DetectionResult =
  | { readonly ok: true; readonly mimeType: AllowedMimeType }
  | { readonly ok: false; readonly reason: string };

interface Signature {
  readonly mimeType: AllowedMimeType;
  readonly bytes: readonly number[];
  readonly offset?: number;
}

const ALLOWED: readonly Signature[] = [
  // %PDF-
  { mimeType: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // JPEG SOI + marker
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  // PNG signature
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP — the "WEBP" tag sits at offset 8
  { mimeType: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
];

/**
 * Formats that must never be stored, checked before the allow-list so the
 * rejection reason is specific rather than a generic "unrecognised".
 *
 * The allow-list alone would already refuse these; naming them means the
 * §12.1 security review can see the threat was considered, and gives the
 * admin queue a useful message rather than "unknown type".
 */
const DANGEROUS: ReadonlyArray<{ readonly label: string; readonly bytes: readonly number[] }> = [
  { label: "Windows executable (PE/DOS)", bytes: [0x4d, 0x5a] },
  { label: "Linux executable (ELF)", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: "shell script", bytes: [0x23, 0x21] },
  { label: "Java class file", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  /*
   * ZIP is rejected outright, and this is a deliberate product decision rather
   * than an oversight. A zip is also what .docx and .xlsx are, so allowing it
   * would mean accepting arbitrary nested content and inheriting the whole
   * archive-bomb and path-traversal surface. A pharmacist can export a PDF;
   * the platform does not need to parse Office formats to check a
   * registration certificate.
   */
  { label: "archive (zip/docx/xlsx)", bytes: [0x50, 0x4b, 0x03, 0x04] },
];

function startsWith(
  buffer: Buffer,
  bytes: readonly number[],
  offset = 0,
): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => buffer[offset + i] === byte);
}

export function detectMimeType(buffer: Buffer): DetectionResult {
  if (buffer.length === 0) {
    return { ok: false, reason: "file is empty" };
  }

  for (const danger of DANGEROUS) {
    if (startsWith(buffer, danger.bytes)) {
      return {
        ok: false,
        reason: `rejected: file is a ${danger.label}, not a document`,
      };
    }
  }

  for (const signature of ALLOWED) {
    if (startsWith(buffer, signature.bytes, signature.offset ?? 0)) {
      return { ok: true, mimeType: signature.mimeType };
    }
  }

  return {
    ok: false,
    reason: "unrecognised file type; upload a PDF, JPEG, PNG or WebP",
  };
}

/**
 * Maximum accepted upload size.
 *
 * A phone photo of a certificate is comfortably under this. The cap exists
 * because an unbounded upload endpoint is a denial-of-service vector against
 * both storage cost and the scanner (§12.1 lists rate limiting and upload
 * validation together for that reason).
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export function validateSize(byteLength: number): DetectionResult | undefined {
  if (byteLength > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      reason: `file is larger than ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB`,
    };
  }
  return undefined;
}

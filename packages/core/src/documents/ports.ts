/**
 * Ports for the two things this package cannot do itself: store bytes and scan
 * them for malware.
 *
 * Both are interfaces rather than direct S3/ClamAV calls so the verification
 * workflow is testable without a cloud account or a virus daemon, and so the
 * §15 "E — externally-blocked" pieces can land later without touching domain
 * logic. The in-memory implementations below are for tests and local
 * development only.
 */

export interface StoredObject {
  readonly storageKey: string;
  readonly sizeBytes: number;
}

export interface DocumentStorage {
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
}

export type ScanVerdict =
  | { readonly clean: true }
  | { readonly clean: false; readonly detail: string };

export interface DocumentScanner {
  scan(body: Buffer): Promise<ScanVerdict>;
}

/** Local development / test storage. Never wire this into production. */
export class InMemoryDocumentStorage implements DocumentStorage {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<StoredObject> {
    this.objects.set(key, body);
    return { storageKey: key, sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<Buffer | undefined> {
    return this.objects.get(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/**
 * The EICAR test string — the industry-standard harmless file that every real
 * scanner is required to report as infected.
 *
 * Split so this source file does not itself trip a scanner reading the repo.
 */
const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Stub scanner for tests and local development.
 *
 * Detects EICAR and nothing else, which is exactly enough to prove the
 * pipeline routes an infected verdict correctly — §14 asks for a malicious
 * upload fixture set so the file-upload gate is "runnable rather than
 * aspirational".
 *
 * This is NOT a malware scanner. §12.1 requires a real one before launch, and
 * `assertProductionReady` in the API refuses to boot with this wired in.
 */
export class StubDocumentScanner implements DocumentScanner {
  async scan(body: Buffer): Promise<ScanVerdict> {
    if (body.includes(Buffer.from(EICAR, "utf8"))) {
      return { clean: false, detail: "EICAR test signature" };
    }
    return { clean: true };
  }
}

export const EICAR_TEST_STRING = EICAR;

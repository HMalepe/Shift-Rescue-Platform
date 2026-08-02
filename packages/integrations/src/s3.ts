import { createHash, createHmac } from "node:crypto";
import type { DocumentStorage, StoredObject } from "@locum/core";

/**
 * §5/§10/§12.1 — the real `DocumentStorage`, backed by S3.
 *
 * `InMemoryDocumentStorage` was the only implementation, and its own header
 * says "never wire this into production". What it stores are SAPC registration
 * certificates, South African ID documents and payslips — special personal
 * information under POPIA, belonging to people who uploaded them to get work.
 *
 * ## Signed by hand, deliberately
 *
 * This implements SigV4 rather than pulling in `@aws-sdk/client-s3`. Three
 * operations are needed — put, get, delete — and the SDK brings a large
 * dependency tree, its own credential-resolution chain (which reads ambient
 * environment and instance metadata, and will happily find credentials nobody
 * intended it to use) and its own retry policy layered under ours.
 *
 * The cost is that the signing has to be right, which is why it is factored
 * into pure functions and asserted directly below. SigV4 fails closed and
 * loudly — a wrong signature is a 403 on every request, not silent corruption
 * — so this is a good trade in a way it would not be for, say, encryption.
 *
 * ## Encryption is not optional here
 *
 * `kmsKeyId` is required by the type. There is no unencrypted path and no
 * "encryption defaults to off if unset", because the failure mode of that
 * design is a bucket of identity documents that everyone believes is
 * encrypted. §10 treats these as special personal information; encryption at
 * rest is the baseline expectation, and a config field that can be quietly
 * omitted is not a baseline.
 *
 * ## What this deliberately does NOT do
 *
 * It does not make anything public, ever — no ACLs, no public-read. Retrieval
 * goes through `packages/core/src/documents/signed-url.ts`, which binds a URL
 * to a recipient and expires it in five minutes. `presignGet` exists for the
 * case where bytes must be streamed from S3 directly, and it is capped at the
 * same TTL rather than accepting whatever a caller passes.
 */

export interface S3Config {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Required. See the header — there is no unencrypted path, because a config
   * field that can be omitted is how a bucket of ID documents ends up
   * unencrypted while everyone believes otherwise.
   */
  readonly kmsKeyId: string;
  /**
   * Overrides the AWS endpoint, for tests and for MinIO. When set, requests use
   * path-style addressing (`/bucket/key`); otherwise virtual-hosted style. The
   * canonical URI must match whichever is used or every signature is wrong, so
   * the two are derived together in `endpointFor` rather than separately.
   */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Matches DEFAULT_SIGNED_URL_TTL_SECONDS in core — five minutes. */
export const MAX_PRESIGN_TTL_SECONDS = 300;

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

/**
 * RFC 3986 encoding, which is not what `encodeURIComponent` does.
 *
 * `!'()*` are left literal by JavaScript and must be escaped here. Getting this
 * wrong produces a valid-looking signature that AWS rejects with 403
 * SignatureDoesNotMatch — and only for keys containing those characters, so it
 * passes every test written with ordinary filenames and fails on the first
 * upload named `certificate (1).pdf`.
 */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encodes an object key for the canonical URI.
 *
 * S3 is the documented exception to SigV4's normalisation rules: path segments
 * are encoded ONCE, and `/` stays a separator. Every other AWS service
 * double-encodes. Following the general rule here breaks every key containing
 * a slash — which is every key this application creates, since they are
 * namespaced `locums/{id}/{documentId}`.
 */
export function canonicalKeyPath(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The SigV4 signing key: four chained HMACs, date then region then service.
 *
 * Chained so the derived key is scoped — a key leaked from one day, region and
 * service cannot sign for another. Exported because it is worth asserting the
 * chaining directly; a version that HMACs the secret once would produce
 * perfectly stable signatures and silently discard that property.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(SERVICE).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

export interface CanonicalRequestInput {
  readonly method: string;
  readonly canonicalUri: string;
  readonly canonicalQuery: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

export interface CanonicalRequest {
  readonly canonical: string;
  readonly signedHeaders: string;
}

/**
 * Builds the canonical request.
 *
 * Header names are lowercased and sorted, values trimmed with internal runs of
 * whitespace collapsed. All three are load-bearing: AWS rebuilds this string on
 * its side and compares hashes, so any disagreement about ordering or spacing
 * is a 403 with no indication of which of the two it was.
 */
export function buildCanonicalRequest(input: CanonicalRequestInput): CanonicalRequest {
  const normalised = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = normalised.map(([n, v]) => `${n}:${v}\n`).join("");
  const signedHeaders = normalised.map(([n]) => n).join(";");

  return {
    canonical: [
      input.method,
      input.canonicalUri,
      input.canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      input.payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

export function credentialScope(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/${SERVICE}/aws4_request`;
}

export function stringToSign(
  amzDate: string,
  scope: string,
  canonicalRequest: string,
): string {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
}

/** `20260802T175900Z` and `20260802`, the two forms SigV4 wants. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export class S3Error extends Error {
  readonly status: number;
  /** S3's own error code, parsed from the XML body — `NoSuchKey`, … */
  readonly code: string | undefined;
  readonly retryable: boolean;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

/**
 * Pulls the error code out of S3's XML.
 *
 * S3 does not speak JSON. A `.json()` parse fails, and the resulting error
 * message is about JSON rather than about the 403 that actually happened —
 * which turns "the KMS key is wrong" into "Unexpected token < in JSON", the
 * least useful possible description of an access-denied.
 */
export function parseS3ErrorCode(body: string): string | undefined {
  return /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
}

export class S3DocumentStorage implements DocumentStorage {
  private readonly config: S3Config;

  constructor(config: S3Config) {
    if (!config.kmsKeyId) {
      /*
       * Belt and braces with the required field on the type — config often
       * arrives from environment variables, where the type system is not
       * present and an unset variable is the empty string rather than
       * undefined. That is exactly the path by which encryption gets silently
       * disabled.
       */
      throw new Error(
        "S3DocumentStorage requires kmsKeyId: these objects are ID documents and " +
          "SAPC certificates (POPIA special personal information, §10).",
      );
    }
    this.config = config;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const response = await this.request("PUT", key, {
      body,
      headers: {
        "content-type": contentType,
        /*
         * SSE-KMS, named explicitly on every write. Bucket default encryption
         * exists and should also be set, but it lives in Terraform where a
         * later edit can remove it without any code change — and the objects
         * already written stay as they were. Asking per-object means a bucket
         * misconfiguration cannot quietly produce plaintext ID documents.
         */
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": this.config.kmsKeyId,
      },
    });

    if (response.status !== 200) {
      throw new S3Error(
        response.status,
        `S3 PUT failed with ${response.status}`,
        parseS3ErrorCode(response.body),
      );
    }

    return { storageKey: key, sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<Buffer | undefined> {
    const response = await this.request("GET", key, {});

    /*
     * Undefined, not an exception. The port's contract is `Buffer |
     * undefined`, and a missing object is an ordinary outcome — a document
     * erased under §10 is exactly this, and it must not page anyone.
     */
    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      throw new S3Error(
        response.status,
        `S3 GET failed with ${response.status}`,
        parseS3ErrorCode(response.body),
      );
    }
    return response.bytes;
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key, {});

    // S3 answers 204 for a successful delete and, being eventually consistent
    // about deletes it has already applied, also 204 for one that is not there.
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw new S3Error(
        response.status,
        `S3 DELETE failed with ${response.status}`,
        parseS3ErrorCode(response.body),
      );
    }
  }

  /**
   * A presigned GET, capped at the same five minutes as our own signed URLs.
   *
   * The TTL is clamped rather than trusted. §12.1 requires retrieval URLs to
   * expire, and a caller passing a week — by mistake, or because a week was
   * convenient during development — would produce a bearer link to someone's
   * identity document that outlives every session, log rotation and support
   * ticket it appears in.
   */
  presignGet(
    key: string,
    ttlSeconds: number = MAX_PRESIGN_TTL_SECONDS,
    now: Date = new Date(),
  ): string {
    const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_PRESIGN_TTL_SECONDS);
    const { amzDate, dateStamp } = amzDates(now);
    const { host, url, canonicalUri } = this.endpointFor(key);
    const scope = credentialScope(dateStamp, this.config.region);

    const query: Array<readonly [string, string]> = [
      ["X-Amz-Algorithm", ALGORITHM],
      ["X-Amz-Credential", `${this.config.accessKeyId}/${scope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(ttl)],
      ["X-Amz-SignedHeaders", "host"],
    ];
    const canonicalQuery = canonicalQueryString(query);

    const { canonical } = buildCanonicalRequest({
      method: "GET",
      canonicalUri,
      canonicalQuery,
      headers: { host },
      /*
       * UNSIGNED-PAYLOAD, which is correct for a presigned GET: there is no
       * body to hash, and the recipient is a browser that cannot compute one.
       */
      payloadHash: "UNSIGNED-PAYLOAD",
    });

    const signature = createHmac(
      "sha256",
      signingKey(this.config.secretAccessKey, dateStamp, this.config.region),
    )
      .update(stringToSign(amzDate, scope, canonical))
      .digest("hex");

    return `${url}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  /**
   * Resolves the endpoint and the canonical URI TOGETHER.
   *
   * Path-style and virtual-hosted style disagree about whether the bucket is
   * part of the path, and the canonical URI must match the URL actually
   * requested. Deriving them in one place is what stops a test against a local
   * endpoint from passing while production 403s on every request.
   */
  private endpointFor(key: string): { host: string; url: string; canonicalUri: string } {
    const encodedKey = canonicalKeyPath(key);

    if (this.config.endpoint) {
      const base = new URL(this.config.endpoint);
      return {
        host: base.host,
        url: `${base.origin}/${this.config.bucket}/${encodedKey}`,
        canonicalUri: `/${this.config.bucket}/${encodedKey}`,
      };
    }

    const host = `${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
    return { host, url: `https://${host}/${encodedKey}`, canonicalUri: `/${encodedKey}` };
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    options: { body?: Buffer; headers?: Record<string, string> },
  ): Promise<{ status: number; body: string; bytes: Buffer }> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const { amzDate, dateStamp } = amzDates(new Date());
    const { host, url, canonicalUri } = this.endpointFor(key);

    /*
     * The body is hashed rather than sent as UNSIGNED-PAYLOAD. S3 verifies it,
     * so this is the one end-to-end integrity check on the upload path: a
     * document corrupted in transit is rejected rather than stored, and a
     * corrupted SAPC certificate is indistinguishable from a forged one to
     * whoever reviews it months later.
     */
    const payloadHash = sha256Hex(options.body ?? "");

    const headers: Record<string, string> = {
      ...options.headers,
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    const { canonical, signedHeaders } = buildCanonicalRequest({
      method,
      canonicalUri,
      canonicalQuery: "",
      headers,
      payloadHash,
    });

    const scope = credentialScope(dateStamp, this.config.region);
    const signature = createHmac(
      "sha256",
      signingKey(this.config.secretAccessKey, dateStamp, this.config.region),
    )
      .update(stringToSign(amzDate, scope, canonical))
      .digest("hex");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);

    try {
      const response = await doFetch(url, {
        method,
        headers: {
          ...headers,
          authorization:
            `${ALGORITHM} Credential=${this.config.accessKeyId}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        ...(options.body ? { body: new Uint8Array(options.body) } : {}),
        signal: controller.signal,
      });

      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        // Only decoded for error parsing; document bytes stay a Buffer.
        body: response.status >= 400 ? bytes.toString("utf8") : "",
        bytes,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new S3Error(408, `S3 ${method} timed out`);
      }
      throw new S3Error(
        0,
        error instanceof Error ? error.message : `S3 ${method} failed`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function canonicalQueryString(
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  return [...entries]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

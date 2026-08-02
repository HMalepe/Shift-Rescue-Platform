import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_PRESIGN_TTL_SECONDS,
  S3DocumentStorage,
  S3Error,
  amzDates,
  buildCanonicalRequest,
  canonicalKeyPath,
  parseS3ErrorCode,
  rfc3986,
  signingKey,
  stringToSign,
} from "../src/index";

/**
 * GATE: storage.s3_adapter
 *
 * §15 lists AWS as externally blocked — there is no account here, so nothing
 * below proves a byte reached S3.
 *
 * What it does prove is the part that is wrong silently. SigV4 fails closed:
 * a bad signature is a 403 on every request, immediately and unmistakably. The
 * dangerous failures are the ones that are conditional — a key encoding that
 * works for `cert.pdf` and 403s on `certificate (1).pdf`, or a signature that
 * matches against a local endpoint and not against AWS. Those are what the
 * tests concentrate on, along with the one property that fails silently in the
 * other direction: encryption.
 *
 * NOTE ON WHAT IS NOT ASSERTED. There are no hard-coded expected signature
 * hexes here. AWS publishes reference vectors, but reproducing one from memory
 * would produce a test that asserts my recollection rather than the algorithm
 * — and it would pass, because I would have written the code from the same
 * recollection. The properties asserted instead (scoping, ordering, encoding,
 * sensitivity to each input) are the ones a wrong implementation actually
 * violates. A real vector should be added the day someone can paste one from
 * the AWS docs.
 */

let s3: Server;
let endpoint = "";
let received: Array<{
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}> = [];
let respondWith: { status: number; payload: string | Buffer } = { status: 200, payload: "" };
let delayMs = 0;

beforeAll(async () => {
  s3 = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const send = () => {
        res.writeHead(respondWith.status);
        res.end(respondWith.payload);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve));
  const address = s3.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => s3.close(() => resolve()));
});

function storage(overrides: Record<string, unknown> = {}) {
  received = [];
  delayMs = 0;
  respondWith = { status: 200, payload: "" };
  return new S3DocumentStorage({
    bucket: "locum-documents",
    region: "af-south-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    kmsKeyId: "arn:aws:kms:af-south-1:111122223333:key/abcd",
    endpoint,
    ...overrides,
  });
}

describe("GATE storage.s3_adapter — encryption is not optional", () => {
  it("refuses to construct without a KMS key", () => {
    /*
     * The type already requires it. This covers the path the type cannot:
     * config from environment variables, where an unset variable arrives as
     * the empty string. That is precisely how a bucket of ID documents ends up
     * unencrypted while every reviewer believes otherwise.
     */
    expect(() => storage({ kmsKeyId: "" })).toThrow(/requires kmsKeyId/);
  });

  it("names SSE-KMS on every single write", async () => {
    /*
     * Per-object rather than relying on bucket default encryption. The bucket
     * default lives in Terraform, where a later edit can remove it with no
     * code change — and objects already written keep whatever they had. Asking
     * every time means a bucket misconfiguration cannot quietly start
     * producing plaintext.
     */
    await storage().put("locums/l-1/sapc.pdf", Buffer.from("%PDF-1.4"), "application/pdf");

    const headers = received[0]!.headers;
    expect(headers["x-amz-server-side-encryption"]).toBe("aws:kms");
    expect(headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe(
      "arn:aws:kms:af-south-1:111122223333:key/abcd",
    );
  });

  it("never puts the secret access key on the wire", async () => {
    // The access key ID is public and appears in the Credential. The secret
    // belongs only inside the HMAC chain.
    await storage().put("locums/l-1/id.pdf", Buffer.from("x"), "application/pdf");

    const wire = JSON.stringify({
      headers: received[0]!.headers,
      url: received[0]!.url,
      body: received[0]!.body.toString("utf8"),
    });
    expect(wire).not.toContain("wJalrXUtnFEMI");
    expect(wire).toContain("AKIAEXAMPLE");
  });
});

describe("GATE storage.s3_adapter — the encoding that fails conditionally", () => {
  it("escapes the characters encodeURIComponent leaves alone", () => {
    /*
     * `!'()*` are literal in JavaScript's encoding and must be escaped for
     * RFC 3986. A key with none of them signs correctly, so this passes every
     * test written with tidy filenames and 403s on the first upload actually
     * named `certificate (1).pdf` — which is what a browser download is
     * called on the second attempt.
     */
    expect(rfc3986("certificate (1).pdf")).toBe("certificate%20%281%29.pdf");
    expect(encodeURIComponent("certificate (1).pdf")).toBe("certificate%20(1).pdf");
    expect(rfc3986("a!b*c'd")).toBe("a%21b%2Ac%27d");
    // Unreserved characters stay literal, or the signature is wrong the other way.
    expect(rfc3986("a-b_c.d~e")).toBe("a-b_c.d~e");
  });

  it("keeps slashes as separators and encodes segments once", () => {
    /*
     * S3 is the documented exception to SigV4's normalisation: single
     * encoding, `/` preserved. Applying the general double-encoding rule
     * breaks every namespaced key — which is every key this app writes.
     */
    expect(canonicalKeyPath("locums/l-1/sapc cert.pdf")).toBe(
      "locums/l-1/sapc%20cert.pdf",
    );
    expect(canonicalKeyPath("locums/l-1/sapc cert.pdf")).not.toContain("%2F");
  });

  it("puts the encoded key in the request path", async () => {
    await storage().put("locums/l-1/sapc cert.pdf", Buffer.from("x"), "application/pdf");
    expect(received[0]!.url).toBe("/locum-documents/locums/l-1/sapc%20cert.pdf");
  });
});

describe("GATE storage.s3_adapter — signing properties", () => {
  it("scopes the signing key to date, region and service", () => {
    /*
     * Four chained HMACs. The chaining is the point: a derived key that leaks
     * cannot sign for another day or another region. An implementation that
     * HMACs the secret once produces stable, working signatures and silently
     * throws that away — nothing fails, which is why it is asserted.
     */
    const base = signingKey("secret", "20260802", "af-south-1");

    expect(base.equals(signingKey("secret", "20260803", "af-south-1"))).toBe(false);
    expect(base.equals(signingKey("secret", "20260802", "eu-west-1"))).toBe(false);
    expect(base.equals(signingKey("other", "20260802", "af-south-1"))).toBe(false);
    // Deterministic for the same inputs, or nothing would ever verify.
    expect(base.equals(signingKey("secret", "20260802", "af-south-1"))).toBe(true);
  });

  it("sorts and lowercases headers, and collapses whitespace in values", () => {
    /*
     * AWS rebuilds this string on its side and compares hashes, so any
     * disagreement about ordering or spacing is a 403 that says nothing about
     * which of the two it was.
     */
    const { canonical, signedHeaders } = buildCanonicalRequest({
      method: "PUT",
      canonicalUri: "/k",
      canonicalQuery: "",
      headers: { "X-Amz-Date": "20260802T000000Z", Host: "example", "Content-Type": "a  b" },
      payloadHash: "abc",
    });

    expect(signedHeaders).toBe("content-type;host;x-amz-date");
    expect(canonical).toContain("content-type:a b\n");
    expect(canonical.indexOf("host:")).toBeLessThan(canonical.indexOf("x-amz-date:"));
  });

  it("changes the string to sign when any input changes", () => {
    const a = stringToSign("20260802T000000Z", "20260802/af-south-1/s3/aws4_request", "REQ");
    expect(a).not.toBe(
      stringToSign("20260802T000001Z", "20260802/af-south-1/s3/aws4_request", "REQ"),
    );
    expect(a).not.toBe(
      stringToSign("20260802T000000Z", "20260802/eu-west-1/s3/aws4_request", "REQ"),
    );
    expect(a).not.toBe(
      stringToSign("20260802T000000Z", "20260802/af-south-1/s3/aws4_request", "REQ2"),
    );
    // The canonical request is hashed, not embedded — a 64-hex last line.
    expect(a.split("\n")[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("formats both date forms the way SigV4 wants", () => {
    const { amzDate, dateStamp } = amzDates(new Date("2026-08-02T17:59:00.123Z"));
    expect(amzDate).toBe("20260802T175900Z");
    expect(dateStamp).toBe("20260802");
  });

  it("hashes the body rather than sending UNSIGNED-PAYLOAD", async () => {
    /*
     * S3 verifies this hash, making it the only end-to-end integrity check on
     * the upload path. A document corrupted in transit is rejected rather than
     * stored — and a corrupted SAPC certificate is indistinguishable from a
     * forged one to whoever reviews it months later.
     */
    await storage().put("locums/l-1/c.pdf", Buffer.from("%PDF-1.4"), "application/pdf");

    const sent = received[0]!.headers["x-amz-content-sha256"] as string;
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).not.toBe("UNSIGNED-PAYLOAD");
    expect(received[0]!.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/af-south-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
  });
});

describe("GATE storage.s3_adapter — presigned retrieval", () => {
  it("caps the TTL rather than trusting the caller", () => {
    /*
     * §12.1 requires retrieval URLs to expire. A caller passing a week — by
     * mistake, or because it was convenient during development — would mint a
     * bearer link to someone's identity document that outlives every log
     * rotation and support ticket it lands in.
     */
    const url = storage().presignGet("locums/l-1/id.pdf", 7 * 24 * 3600);
    expect(url).toContain(`X-Amz-Expires=${MAX_PRESIGN_TTL_SECONDS}`);
  });

  it("signs with UNSIGNED-PAYLOAD and host only", () => {
    // Correct for a presigned GET: there is no body, and the recipient is a
    // browser that cannot compute a payload hash.
    const url = storage().presignGet("locums/l-1/id.pdf");
    expect(url).toContain("X-Amz-SignedHeaders=host");
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    expect(url).not.toContain("wJalrXUtnFEMI");
  });

  it("orders query parameters canonically", () => {
    // The canonical query string is sorted; the signature is computed over
    // that exact string, so the URL must carry it in the same order.
    const url = storage().presignGet("locums/l-1/id.pdf");
    const query = url.slice(url.indexOf("?") + 1);
    const names = query.split("&").map((p) => p.split("=")[0]!);
    const withoutSignature = names.filter((n) => n !== "X-Amz-Signature");
    expect(withoutSignature).toEqual([...withoutSignature].sort());
  });
});

describe("GATE storage.s3_adapter — outcomes", () => {
  it("returns undefined for a missing object rather than throwing", async () => {
    /*
     * The port's contract is `Buffer | undefined`, and a missing object is an
     * ordinary outcome — a document erased under §10 is exactly this. Throwing
     * would page someone for a successful privacy deletion.
     */
    const s = storage();
    respondWith = { status: 404, payload: "<Error><Code>NoSuchKey</Code></Error>" };
    expect(await s.get("locums/l-1/gone.pdf")).toBeUndefined();
  });

  it("returns the bytes unchanged", async () => {
    const s = storage();
    const body = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    respondWith = { status: 200, payload: body };
    expect((await s.get("locums/l-1/c.pdf"))!.equals(body)).toBe(true);
  });

  it("parses S3's XML error code instead of failing on JSON", async () => {
    /*
     * S3 does not speak JSON. A `.json()` parse turns "the KMS key is wrong"
     * into "Unexpected token < in JSON" — the least useful possible
     * description of an access-denied.
     */
    expect(parseS3ErrorCode("<Error><Code>AccessDenied</Code></Error>")).toBe("AccessDenied");

    const s = storage();
    respondWith = { status: 403, payload: "<Error><Code>AccessDenied</Code></Error>" };
    const error = (await s
      .put("locums/l-1/c.pdf", Buffer.from("x"), "application/pdf")
      .catch((e: unknown) => e)) as S3Error;

    expect(error).toBeInstanceOf(S3Error);
    expect(error.code).toBe("AccessDenied");
    expect(error.retryable).toBe(false);
  });

  it("treats a 5xx as retryable and a 403 as not", async () => {
    const s = storage();
    respondWith = { status: 503, payload: "<Error><Code>SlowDown</Code></Error>" };
    const error = (await s
      .put("locums/l-1/c.pdf", Buffer.from("x"), "application/pdf")
      .catch((e: unknown) => e)) as S3Error;
    expect(error.retryable).toBe(true);
  });

  it("tolerates a delete of something already gone", async () => {
    // Uploads are retried and erasure runs more than once; a delete that finds
    // nothing has achieved what it was asked to achieve.
    const s = storage();
    respondWith = { status: 404, payload: "<Error><Code>NoSuchKey</Code></Error>" };
    await expect(s.delete("locums/l-1/gone.pdf")).resolves.toBeUndefined();
  });

  it("times out rather than hanging the request", async () => {
    const s = storage({ timeoutMs: 150 });
    delayMs = 2_000;
    const error = (await s.get("locums/l-1/c.pdf").catch((e: unknown) => e)) as S3Error;
    expect(error).toBeInstanceOf(S3Error);
    expect(error.status).toBe(408);
    expect(error.retryable).toBe(true);
  });
});

describe("GATE storage.s3_adapter — addressing", () => {
  it("uses virtual-hosted style against real AWS", async () => {
    /*
     * Path-style and virtual-hosted style disagree about whether the bucket is
     * in the path, and the canonical URI must match the URL requested. Derived
     * together for that reason — otherwise a suite passing against a local
     * endpoint 403s on every production request, and the tests say nothing.
     */
    const captured: Array<{ url: string; host: string }> = [];
    const s = new S3DocumentStorage({
      bucket: "locum-documents",
      region: "af-south-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      kmsKeyId: "arn:aws:kms:af-south-1:111122223333:key/abcd",
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured.push({
          url: String(url),
          host: (init.headers as Record<string, string>)["host"]!,
        });
        return new Response(new ArrayBuffer(0), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await s.put("locums/l-1/c.pdf", Buffer.from("x"), "application/pdf");

    expect(captured[0]!.url).toBe(
      "https://locum-documents.s3.af-south-1.amazonaws.com/locums/l-1/c.pdf",
    );
    // The signed host header must be the one actually addressed.
    expect(captured[0]!.host).toBe("locum-documents.s3.af-south-1.amazonaws.com");
  });
});

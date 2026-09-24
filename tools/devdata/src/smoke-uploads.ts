import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { EICAR_TEST_STRING, isDomainError, uploadDocument } from "@locum/core";
import { ClamavDocumentScanner, S3DocumentStorage, type SseConfig } from "@locum/integrations";
import { createDatabase } from "@locum/db";
import { documents, users } from "@locum/db/schema";

/**
 * §5/§10/§12.1 — operational smoke test for the real document pipeline.
 *
 * None of S3DocumentStorage, ClamavDocumentScanner or a real signed-URL
 * fetch has ever run against live vendors — `uploadDocument`'s only test
 * coverage is against `InMemoryDocumentStorage`/`StubDocumentScanner`
 * (packages/core/test), which exist specifically so unit tests do not need
 * a bucket or a clamd reachable over TCP. That is correct for unit tests and
 * proves nothing about whether the real SigV4 signing in s3.ts, the real
 * INSTREAM protocol in clamav.ts, or a real signed GET actually work against
 * the vendor this deploy is pointed at. This script is that missing check.
 *
 * Deliberately NOT part of `make verify` / CI: it needs a real S3-compatible
 * bucket and a real clamd daemon, neither of which exist in the test
 * environment (that is exactly why the in-memory/stub adapters exist). Run
 * by hand after the `api`/`clamav` services are deployed — see
 * docs/RAILWAY.md's "After all services exist" section for the exact
 * command and required environment.
 *
 * ## Refusing to test the stubs by accident
 *
 * There is no fallback anywhere in this file — unlike apps/api/src/main.ts,
 * which falls back to `InMemoryDocumentStorage`/`StubDocumentScanner`
 * whenever the real config is incomplete, this script never imports either
 * stub class at all. Every credential below is required()'d up front: an
 * unset S3/ClamAV variable exits before either adapter is constructed. A
 * script that quietly ran against the in-memory store and reported PASS
 * would be worse than not running at all — it would look like this had been
 * checked.
 */

let failures = 0;
function pass(label: string): void {
  console.log(`  PASS  ${label}`);
}
function fail(label: string, detail?: unknown): void {
  failures += 1;
  console.error(`  FAIL  ${label}`);
  if (detail !== undefined) console.error(`        ${String(detail)}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `error: ${name} is required — this is a live-infra smoke test, not something that runs against a default`,
    );
    process.exit(2);
  }
  return value;
}

const databaseUrl = required("DATABASE_URL");
const s3Bucket = required("S3_BUCKET");
const s3Region = process.env["S3_REGION"] ?? "af-south-1";
const awsAccessKeyId = required("AWS_ACCESS_KEY_ID");
const awsSecretAccessKey = required("AWS_SECRET_ACCESS_KEY");
const s3SseModeRaw = required("S3_SSE_MODE");
const s3Endpoint = process.env["S3_ENDPOINT"];
const s3KmsKeyId = process.env["S3_KMS_KEY_ID"];

const clamdHost = required("CLAMD_HOST");
const clamdPort = Number(process.env["CLAMD_PORT"] ?? "3310");

if (s3SseModeRaw !== "aws-kms" && s3SseModeRaw !== "provider-managed") {
  console.error(`error: S3_SSE_MODE must be "aws-kms" or "provider-managed", got "${s3SseModeRaw}"`);
  process.exit(2);
}
if (s3SseModeRaw === "aws-kms" && !s3KmsKeyId) {
  console.error("error: S3_SSE_MODE=aws-kms requires S3_KMS_KEY_ID");
  process.exit(2);
}
const sse: SseConfig =
  s3SseModeRaw === "aws-kms" ? { mode: "aws-kms", kmsKeyId: s3KmsKeyId! } : { mode: "provider-managed" };

const storage = new S3DocumentStorage({
  bucket: s3Bucket,
  region: s3Region,
  accessKeyId: awsAccessKeyId,
  secretAccessKey: awsSecretAccessKey,
  sse,
  ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
});
const scanner = new ClamavDocumentScanner({ host: clamdHost, port: clamdPort });
const deps = { storage, scanner };

const { db, client } = createDatabase({ url: databaseUrl, maxConnections: 2 });

console.log(`smoke-uploads: bucket=${s3Bucket} region=${s3Region} clamd=${clamdHost}:${clamdPort}`);

// A throwaway user purely to satisfy documents.user_id's FK — cleaned up in
// the `finally` block below regardless of pass/fail. A failure here is a
// precondition failure (can't reach Postgres at all), not a case result, so
// it gets the same treatment as the required() checks above: a clear message
// and a controlled exit, not a raw stack trace.
let userId: string;
try {
  const [testUser] = await db
    .insert(users)
    .values({
      role: "locum",
      email: `smoke-uploads-${randomUUID()}@test.invalid`,
      fullName: "smoke-uploads.ts fixture",
    })
    .returning({ id: users.id });
  userId = testUser!.id;
} catch (error) {
  console.error("error: could not create the throwaway test user — is DATABASE_URL reachable?");
  console.error(error);
  await client.end();
  process.exit(2);
}

/*
 * Each case is its own function, called under its own try/catch below,
 * specifically so a real failure anywhere — a scanner that cannot connect, a
 * signature the bucket rejects, a network timeout — becomes one clean FAIL
 * line and lets the rest of the script (the other case, then cleanup) keep
 * running, rather than an uncaught exception that skips straight past the
 * PASS/FAIL summary and the exit code this script's whole job is to produce.
 */

async function runCase1(): Promise<void> {
  console.log("\nCase 1: EICAR is rejected by the real scanner, nothing is stored");

  // %PDF- prefix so the EICAR body passes server-side magic-byte detection
  // and actually reaches the scanner — a bare EICAR string has no allowed
  // file signature and would be rejected before the scan ever ran, which
  // would prove nothing about ClamAV. Same construction the gate tests use
  // (apps/api/test/verification-profile-routes.test.ts).
  const infectedBody = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "ascii"),
    Buffer.from(EICAR_TEST_STRING, "ascii"),
  ]);

  try {
    const verdict = await scanner.scan(infectedBody);
    if (verdict.clean) {
      fail("the real ClamAV daemon flags the EICAR test string", "scanner reported clean=true");
    } else {
      pass(`the real ClamAV daemon flags the EICAR test string (signature: ${verdict.detail})`);
    }
  } catch (error) {
    fail("the real ClamAV daemon flags the EICAR test string", error);
  }

  try {
    await uploadDocument(db, deps, { userId, type: "identity_document", body: infectedBody });
    fail("uploadDocument rejects the infected upload", "resolved instead of throwing");
  } catch (error) {
    if (isDomainError(error) && error.code === "DOCUMENT_REJECTED") {
      pass("uploadDocument rejects the infected upload (DOCUMENT_REJECTED)");
    } else {
      fail("uploadDocument rejects the infected upload", error);
    }
  }

  try {
    const [infectedRow] = await db
      .select({ storageKey: documents.storageKey, scan: documents.scan })
      .from(documents)
      .where(eq(documents.userId, userId));
    if (infectedRow?.scan === "infected" && infectedRow.storageKey === "") {
      pass("nothing was written to the bucket for the infected upload");
    } else {
      fail("nothing was written to the bucket for the infected upload", infectedRow);
    }
  } catch (error) {
    fail("nothing was written to the bucket for the infected upload", error);
  }
}

async function runCase2(): Promise<void> {
  console.log("\nCase 2: a clean file is stored, and its signed URL round-trips the exact bytes");

  const cleanBody = Buffer.concat([
    // PNG signature, so detectMimeType accepts it the same way it would a
    // real phone photo of a certificate.
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`shift-rescue-platform smoke-uploads ${new Date().toISOString()} ${randomUUID()}`),
  ]);

  let uploadedId: string;
  try {
    const uploaded = await uploadDocument(db, deps, {
      userId,
      type: "identity_document",
      body: cleanBody,
    });
    uploadedId = uploaded.id;
    if (uploaded.scan === "clean") {
      pass(`clean file accepted and stored (document ${uploaded.id})`);
    } else {
      fail("clean file accepted and stored", `scan status was "${uploaded.scan}"`);
    }
  } catch (error) {
    // Nothing was stored, so there is no storage key to test retrieval
    // against — the rest of this case cannot run.
    fail("clean file accepted and stored", error);
    return;
  }

  let storageKey: string | undefined;
  try {
    const [cleanRow] = await db
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, uploadedId));
    storageKey = cleanRow?.storageKey;
  } catch (error) {
    fail("resolved the uploaded object's storage key", error);
  }

  if (!storageKey) {
    fail("resolved the uploaded object's storage key", "no storage_key on the document row");
    return;
  }

  const signedUrl = storage.presignGet(storageKey);
  if (signedUrl.includes("X-Amz-Expires=") && signedUrl.includes("X-Amz-Signature=")) {
    pass("signed URL carries an expiry and a signature");
  } else {
    fail("signed URL carries an expiry and a signature", signedUrl);
  }

  try {
    const signedResponse = await fetch(signedUrl);
    if (!signedResponse.ok) {
      fail("fetching the signed URL succeeds", `HTTP ${signedResponse.status}`);
    } else {
      const fetchedBytes = Buffer.from(await signedResponse.arrayBuffer());
      if (fetchedBytes.equals(cleanBody)) {
        pass("bytes fetched via the signed URL match exactly what was uploaded");
      } else {
        fail(
          "bytes fetched via the signed URL match exactly what was uploaded",
          `expected ${cleanBody.byteLength} bytes, got ${fetchedBytes.byteLength}`,
        );
      }
    }
  } catch (error) {
    fail("fetching the signed URL succeeds", error);
  }

  /*
   * The same object, requested with no query string at all — proof the
   * object is not readable to an unauthenticated GET, not just that a
   * signed one happens to work. A bucket that is accidentally public would
   * still pass every check above.
   */
  try {
    const bareUrl = signedUrl.split("?")[0]!;
    const publicResponse = await fetch(bareUrl);
    if (publicResponse.status === 200) {
      fail("object is not publicly readable without the signature", "bare URL returned HTTP 200");
    } else {
      pass(`object is not publicly readable without the signature (HTTP ${publicResponse.status})`);
    }
  } catch (error) {
    // A connection refused/rejected outright is also "not publicly
    // readable" — only a 200 is the failure case here.
    pass(`object is not publicly readable without the signature (request itself failed: ${String(error)})`);
  }
}

try {
  await runCase1();
  await runCase2();
} finally {
  const rows = await db
    .select({ storageKey: documents.storageKey })
    .from(documents)
    .where(eq(documents.userId, userId));
  for (const row of rows) {
    if (!row.storageKey) continue;
    try {
      await storage.delete(row.storageKey);
    } catch (error) {
      console.error(`warning: failed to delete ${row.storageKey} from the bucket during cleanup`, error);
    }
  }
  await db.delete(documents).where(eq(documents.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await client.end();
}

console.log(`\n${failures === 0 ? "ALL CASES PASSED" : `${failures} CASE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

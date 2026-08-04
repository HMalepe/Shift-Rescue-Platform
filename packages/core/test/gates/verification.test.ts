import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  EICAR_TEST_STRING,
  InMemoryDocumentStorage,
  StubDocumentScanner,
  createSignedUrl,
  detectMimeType,
  listPendingReview,
  reviewDocument,
  uploadDocument,
  verificationHistory,
  verifySignedUrl,
  type DocumentDeps,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: security.file_upload + product.verification
 *
 * §12.1 file-upload scope: "validate file type/size server-side, scan for
 * malware before storage, and ensure signed URLs for retrieval expire".
 *
 * §14 requires a malicious upload fixture set — "oversized file, disguised
 * executable, malformed parser-exploit file — committed as test assets, so the
 * file-upload security gate is runnable rather than aspirational". Those
 * fixtures are constructed below rather than committed as binaries, which
 * keeps a live PE header out of the repository while exercising the same code
 * path.
 */

const { db, client } = connect();
const deps: DocumentDeps = {
  storage: new InMemoryDocumentStorage(),
  scanner: new StubDocumentScanner(),
};
const SECRET = "test-signing-secret-at-least-32-characters";

const createdUserIds: string[] = [];

/** Minimal valid files, by magic bytes. */
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n", "ascii"),
  Buffer.from("certificate body"),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

async function makeLocum() {
  const email = `verif-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await db
    .insert(s.users)
    .values({ role: "locum", email, fullName: "Verification Tester" })
    .returning({ id: s.users.id });
  createdUserIds.push(user!.id);
  await db
    .insert(s.locumProfiles)
    .values({ userId: user!.id, verification: "incomplete" });
  return user!.id;
}

async function makeAdmin() {
  const email = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await db
    .insert(s.users)
    .values({ role: "admin", email, fullName: "Reviewing Admin" })
    .returning({ id: s.users.id });
  createdUserIds.push(user!.id);
  return user!.id;
}

afterEach(async () => {
  const ids = createdUserIds.splice(0);
  if (ids.length === 0) return;
  await db.delete(s.auditLog).where(inArray(s.auditLog.subjectId, ids));
  await db.delete(s.documents).where(inArray(s.documents.userId, ids));
  await db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, ids));
  await db.delete(s.auditLog).where(inArray(s.auditLog.actorId, ids));
  await db.delete(s.users).where(inArray(s.users.id, ids));
});

afterAll(async () => {
  await client.end();
});

describe("GATE security.file_upload — §14 malicious fixtures", () => {
  it("rejects a disguised executable regardless of its name", () => {
    // A Linux ELF binary called sapc-certificate.pdf. An extension or
    // Content-Type check passes this; a magic-byte check does not.
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.alloc(128),
    ]);
    const result = detectMimeType(elf);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/ELF|executable/i);

    // Windows PE.
    const pe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(128)]);
    expect(detectMimeType(pe).ok).toBe(false);

    // Shell script.
    const script = Buffer.from("#!/bin/sh\nrm -rf /\n", "ascii");
    expect(detectMimeType(script).ok).toBe(false);
  });

  it("rejects an archive, including Office formats", () => {
    // .docx and .xlsx are zips. Accepting them means accepting arbitrary
    // nested content and the whole archive-bomb surface.
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64),
    ]);
    expect(detectMimeType(zip).ok).toBe(false);
  });

  it("rejects a malformed file that claims to be a PDF", () => {
    const malformed = Buffer.from("not-really-a-pdf-at-all", "ascii");
    expect(detectMimeType(malformed).ok).toBe(false);
    expect(detectMimeType(Buffer.alloc(0)).ok).toBe(false);
  });

  it("rejects an oversized upload", async () => {
    const userId = await makeLocum();
    const oversized = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "ascii"),
      Buffer.alloc(11 * 1024 * 1024),
    ]);

    await expect(
      uploadDocument(db, deps, {
        userId,
        type: "sapc_certificate",
        body: oversized,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_REJECTED" });
  });

  it("rejects an infected file and records the attempt without storing it", async () => {
    const userId = await makeLocum();
    const infected = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "ascii"),
      Buffer.from(EICAR_TEST_STRING, "ascii"),
    ]);

    await expect(
      uploadDocument(db, deps, {
        userId,
        type: "sapc_certificate",
        body: infected,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_REJECTED" });

    // The attempt is visible to the admin queue — §12.1 treats verification as
    // a social-engineering target, so someone probing it is worth knowing.
    const [row] = await db
      .select({ scan: s.documents.scan, storageKey: s.documents.storageKey })
      .from(s.documents)
      .where(eq(s.documents.userId, userId));

    expect(row?.scan).toBe("infected");
    // The bytes were never written.
    expect(row?.storageKey).toBe("");
  });

  it("accepts a genuine PDF and stores it", async () => {
    const userId = await makeLocum();
    const uploaded = await uploadDocument(db, deps, {
      userId,
      type: "sapc_certificate",
      body: PDF,
    });

    expect(uploaded.detectedMimeType).toBe("application/pdf");
    expect(uploaded.scan).toBe("clean");

    // The bytes really did reach storage, under the key recorded on the row.
    const [row] = await db
      .select({ storageKey: s.documents.storageKey, sha256: s.documents.sha256 })
      .from(s.documents)
      .where(eq(s.documents.id, uploaded.id));

    expect(row!.storageKey).toMatch(new RegExp(`^documents/${userId}/`));
    const stored = await deps.storage.get(row!.storageKey);
    expect(stored?.equals(PDF)).toBe(true);
    expect(row!.sha256).toHaveLength(64);
  });
});

describe("GATE security.file_upload — expiring signed URLs (§12.1)", () => {
  it("accepts a fresh URL and refuses an expired one", () => {
    const { url } = createSignedUrl("doc-1", "user-1", SECRET, 300);
    const params = new URL(`http://x${url}`).searchParams;

    const fresh = verifySignedUrl(
      {
        documentId: "doc-1",
        to: params.get("to") ?? undefined,
        expires: params.get("expires") ?? undefined,
        sig: params.get("sig") ?? undefined,
      },
      SECRET,
      "user-1",
    );
    expect(fresh.valid).toBe(true);

    // Same URL, evaluated an hour later. These documents are ID papers and
    // payslips; a link that never expires is a public one the moment it lands
    // in a log or a screenshot.
    const later = verifySignedUrl(
      {
        documentId: "doc-1",
        to: params.get("to") ?? undefined,
        expires: params.get("expires") ?? undefined,
        sig: params.get("sig") ?? undefined,
      },
      SECRET,
      "user-1",
      Math.floor(Date.now() / 1000) + 3600,
    );
    expect(later).toMatchObject({ valid: false, reason: "expired" });
  });

  it("refuses a forged signature and a tampered expiry", () => {
    const { url } = createSignedUrl("doc-1", "user-1", SECRET);
    const params = new URL(`http://x${url}`).searchParams;

    expect(
      verifySignedUrl(
        { documentId: "doc-1", to: "user-1", expires: params.get("expires")!, sig: "forged" },
        SECRET,
        "user-1",
      ),
    ).toMatchObject({ valid: false, reason: "bad_signature" });

    // Extending the expiry invalidates the signature, which is the point of
    // signing it rather than trusting it.
    expect(
      verifySignedUrl(
        {
          documentId: "doc-1",
          to: "user-1",
          expires: String(Number(params.get("expires")) + 100_000),
          sig: params.get("sig")!,
        },
        SECRET,
        "user-1",
      ),
    ).toMatchObject({ valid: false, reason: "bad_signature" });
  });

  it("refuses a valid URL presented by someone else", () => {
    const { url } = createSignedUrl("doc-1", "user-1", SECRET);
    const params = new URL(`http://x${url}`).searchParams;

    // A link pasted into a shared channel is inert for everyone but its
    // recipient.
    expect(
      verifySignedUrl(
        {
          documentId: "doc-1",
          to: params.get("to")!,
          expires: params.get("expires")!,
          sig: params.get("sig")!,
        },
        SECRET,
        "someone-else",
      ),
    ).toMatchObject({ valid: false, reason: "wrong_recipient" });
  });
});

describe("GATE product.verification — the admin review queue", () => {
  it("uploading moves a locum to complete_unverified, never to verified (§5)", async () => {
    const userId = await makeLocum();
    await uploadDocument(db, deps, {
      userId,
      type: "sapc_certificate",
      body: PDF,
    });

    const [profile] = await db
      .select({ verification: s.locumProfiles.verification })
      .from(s.locumProfiles)
      .where(eq(s.locumProfiles.userId, userId));

    /*
     * The distinction the whole marketplace rests on: a locum can complete
     * their own profile, but only a human admin checking the certificate
     * against the SAPC registry can make them verified.
     */
    expect(profile?.verification).toBe("complete_unverified");
  });

  it("an admin decision records who made it (§12.1)", async () => {
    const userId = await makeLocum();
    const adminId = await makeAdmin();

    const uploaded = await uploadDocument(db, deps, {
      userId,
      type: "sapc_certificate",
      body: PDF,
    });

    await reviewDocument(db, {
      documentId: uploaded.id,
      adminId,
      decision: "verified",
      reason: "checked against SAPC register",
    });

    const [profile] = await db
      .select({
        verification: s.locumProfiles.verification,
        verifiedBy: s.locumProfiles.verifiedBy,
      })
      .from(s.locumProfiles)
      .where(eq(s.locumProfiles.userId, userId));

    expect(profile?.verification).toBe("verified");
    expect(profile?.verifiedBy).toBe(adminId);

    // §12.1: "log every verification decision with the reviewing admin's
    // identity". Written in the same transaction as the decision, so a
    // verified profile with no attributable decision is not reachable.
    const history = await verificationHistory(db, userId);
    expect(history[0]?.action).toBe("verification.verified");
    expect(history[0]?.actorId).toBe(adminId);
    expect(history[0]?.metadata).toContain("SAPC register");
  });

  it("a rejection clears verification and is equally attributable", async () => {
    const userId = await makeLocum();
    const adminId = await makeAdmin();
    const uploaded = await uploadDocument(db, deps, {
      userId,
      type: "sapc_certificate",
      body: PNG,
    });

    await reviewDocument(db, {
      documentId: uploaded.id,
      adminId,
      decision: "rejected",
      reason: "certificate expired",
    });

    const [profile] = await db
      .select({
        verification: s.locumProfiles.verification,
        verifiedAt: s.locumProfiles.verifiedAt,
      })
      .from(s.locumProfiles)
      .where(eq(s.locumProfiles.userId, userId));

    expect(profile?.verification).toBe("rejected");
    expect(profile?.verifiedAt).toBeNull();

    const history = await verificationHistory(db, userId);
    expect(history[0]?.action).toBe("verification.rejected");
  });

  it("refuses to review the same document twice", async () => {
    const userId = await makeLocum();
    const adminId = await makeAdmin();
    const uploaded = await uploadDocument(db, deps, {
      userId,
      type: "sapc_certificate",
      body: PDF,
    });

    await reviewDocument(db, { documentId: uploaded.id, adminId, decision: "verified" });

    await expect(
      reviewDocument(db, { documentId: uploaded.id, adminId, decision: "rejected" }),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_REVIEWED" });
  });

  it("the queue shows unreviewed clean documents and hides reviewed ones", async () => {
    const userId = await makeLocum();
    const adminId = await makeAdmin();
    const uploaded = await uploadDocument(db, deps, {
      userId,
      type: "sapc_certificate",
      body: PDF,
    });

    const before = await listPendingReview(db);
    expect(before.map((r) => r.documentId)).toContain(uploaded.id);

    await reviewDocument(db, { documentId: uploaded.id, adminId, decision: "verified" });

    const after = await listPendingReview(db);
    expect(after.map((r) => r.documentId)).not.toContain(uploaded.id);
  });

  it("an infected document never reaches the review queue", async () => {
    const userId = await makeLocum();
    const infected = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "ascii"),
      Buffer.from(EICAR_TEST_STRING, "ascii"),
    ]);
    await uploadDocument(db, deps, {
      userId,
      type: "sapc_certificate",
      body: infected,
    }).catch(() => {});

    const queue = await listPendingReview(db);
    const mine = queue.filter((r) => r.userId === userId);

    // An admin should never be shown a file that failed its scan, let alone be
    // able to click "approve" on it.
    expect(mine).toHaveLength(0);

    const [row] = await db
      .select({ id: s.documents.id })
      .from(s.documents)
      .where(and(eq(s.documents.userId, userId), eq(s.documents.scan, "infected")));

    await expect(
      reviewDocument(db, {
        documentId: row!.id,
        adminId: await makeAdmin(),
        decision: "verified",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_REVIEWABLE" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { InMemoryDocumentStorage, hashPassword, signDocumentUrl } from "@locum/core";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: product.verification (document retrieval)
 *
 * `verification.myDocuments` and `verification.documentUrl` mint signed URLs
 * pointing at `GET /documents/:id`, but until this route existed no path in
 * the API ever answered them — a document could be uploaded, scanned and
 * reviewed, and never actually retrieved by anyone. These tests exercise the
 * route directly rather than only the signing logic it depends on.
 */

const PASSWORD = "s3cure-password!";
const JHB = { lng: 28.0473, lat: -26.2041 } as const;
const AUTH_SECRET = "test-auth-secret-at-least-32-characters-long";

const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\n", "ascii"),
  Buffer.from("certificate"),
]);
const PDF_BASE64 = PDF_BYTES.toString("base64");

let server: BuiltServer;
const documentStorage = new InMemoryDocumentStorage();
const userIds: string[] = [];
let ipCounter = 0;

beforeAll(async () => {
  server = await buildServer(
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_SECRET,
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
    }),
    { documentStorage },
  );
  await server.app.ready();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await server.db.delete(s.documents).where(inArray(s.documents.userId, userIds));
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, userIds));
    await server.db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, userIds));
    await server.db.delete(s.users).where(inArray(s.users.id, userIds));
  }
  await server.app.close();
  await server.client.end();
});

async function makeLocum() {
  const email = `docs-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await server.db
    .insert(s.users)
    .values({ role: "locum", email, fullName: "Doc Tester", passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: s.users.id });
  userIds.push(user!.id);
  await server.db
    .insert(s.locumProfiles)
    .values({ userId: user!.id, verification: "incomplete", baseLocation: JHB });

  const response = await server.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD },
    headers: { "x-forwarded-for": `198.18.1.${(ipCounter += 1) % 250}` },
  });
  if (response.statusCode !== 200) {
    throw new Error(`fixture login failed (${response.statusCode}): ${response.body}`);
  }
  return { id: user!.id, accessToken: response.json().accessToken as string };
}

async function uploadAndGetDownloadUrl(token: string): Promise<string> {
  await server.app.inject({
    method: "POST",
    url: "/trpc/verification.upload",
    payload: { type: "sapc_certificate", contentBase64: PDF_BASE64, filename: "cert.pdf" },
    headers: { authorization: `Bearer ${token}` },
  });

  const mine = await server.app.inject({
    method: "GET",
    url: `/trpc/verification.myDocuments?input=${encodeURIComponent(JSON.stringify({}))}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const [doc] = mine.json().result.data;
  return doc.download.url as string;
}

describe("GATE product.verification — GET /documents/:id", () => {
  it("serves the uploaded bytes back to the person it was issued to", async () => {
    const locum = await makeLocum();
    const url = await uploadAndGetDownloadUrl(locum.accessToken);

    const response = await server.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${locum.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.compare(response.rawPayload, PDF_BYTES)).toBe(0);
  });

  it("refuses an unauthenticated request", async () => {
    const locum = await makeLocum();
    const url = await uploadAndGetDownloadUrl(locum.accessToken);

    const response = await server.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a signed link presented by someone other than who it was issued to", async () => {
    const owner = await makeLocum();
    const someoneElse = await makeLocum();
    const url = await uploadAndGetDownloadUrl(owner.accessToken);

    // A link pasted into a shared channel must be inert for anyone but the
    // person it was addressed to — §12.1's recipient-binding requirement.
    const response = await server.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${someoneElse.accessToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a link whose signature has been tampered with", async () => {
    const locum = await makeLocum();
    const url = await uploadAndGetDownloadUrl(locum.accessToken);
    const tampered = url.replace(/sig=[^&]+/, "sig=forged0000000000000000000000000000000000000000000");

    const response = await server.app.inject({
      method: "GET",
      url: tampered,
      headers: { authorization: `Bearer ${locum.accessToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses an expired link with 410, distinct from a forged one", async () => {
    const locum = await makeLocum();
    // Upload first so a real document row exists; sign our own URL with an
    // expiry in the past rather than waiting out the real 5-minute TTL.
    await server.app.inject({
      method: "POST",
      url: "/trpc/verification.upload",
      payload: { type: "sapc_certificate", contentBase64: PDF_BASE64 },
      headers: { authorization: `Bearer ${locum.accessToken}` },
    });
    const [document] = await server.db
      .select({ id: s.documents.id })
      .from(s.documents)
      .where(eq(s.documents.userId, locum.id));

    const expiredUrl = signDocumentUrl(
      {
        documentId: document!.id,
        issuedTo: locum.id,
        expiresAt: Math.floor(Date.now() / 1000) - 10,
      },
      AUTH_SECRET,
    );

    const response = await server.app.inject({
      method: "GET",
      url: expiredUrl,
      headers: { authorization: `Bearer ${locum.accessToken}` },
    });
    expect(response.statusCode).toBe(410);
  });

  it("re-checks the scan status at read time, not just at mint time", async () => {
    /*
     * A document could pass its scan when the URL was minted and be found
     * infected before the (up to 5-minute-lived) link is used. The signature
     * only covers documentId/recipient/expiry, so this has to be a fresh
     * database read, not something re-derivable from the URL itself.
     */
    const locum = await makeLocum();
    const url = await uploadAndGetDownloadUrl(locum.accessToken);

    await server.db
      .update(s.documents)
      .set({ scan: "infected", scanDetail: "found after minting" })
      .where(eq(s.documents.userId, locum.id));

    const response = await server.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${locum.accessToken}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 rather than 500 if the object is missing from storage", async () => {
    const locum = await makeLocum();
    const url = await uploadAndGetDownloadUrl(locum.accessToken);

    const [document] = await server.db
      .select({ storageKey: s.documents.storageKey })
      .from(s.documents)
      .where(eq(s.documents.userId, locum.id));
    await documentStorage.delete(document!.storageKey);

    const response = await server.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${locum.accessToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

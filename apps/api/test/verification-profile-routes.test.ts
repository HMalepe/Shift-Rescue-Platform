import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  EICAR_TEST_STRING,
  generateTotpSecret,
  hashPassword,
  signAccessToken,
} from "@locum/core";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: product.verification (transport) + product.profile
 *
 * The assertions that matter here are about who may change what: §12.1 makes
 * the admin verification queue a high-value target, so every route that can
 * flip a locum to "verified" must require MFA at request time, not merely an
 * admin role.
 */

const PASSWORD = "s3cure-password!";
const JHB = { lng: 28.0473, lat: -26.2041 } as const;

const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n", "ascii"),
  Buffer.from("certificate"),
]).toString("base64");

let server: BuiltServer;
const userIds: string[] = [];
const pharmacyIds: string[] = [];
let ipCounter = 0;

beforeAll(async () => {
  server = await buildServer(
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
    }),
  );
  await server.app.ready();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await server.db.delete(s.auditLog).where(inArray(s.auditLog.subjectId, userIds));
    await server.db.delete(s.auditLog).where(inArray(s.auditLog.actorId, userIds));
    await server.db.delete(s.documents).where(inArray(s.documents.userId, userIds));
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, userIds));
    await server.db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, userIds));
  }
  for (const id of pharmacyIds) {
    await server.db.delete(s.pharmacyMembers).where(eq(s.pharmacyMembers.pharmacyId, id));
    await server.db.delete(s.pharmacies).where(eq(s.pharmacies.id, id));
  }
  if (userIds.length > 0) {
    await server.db.delete(s.users).where(inArray(s.users.id, userIds));
  }
  await server.app.close();
  await server.client.end();
});

async function makeActor(
  role: "manager" | "locum" | "admin",
  options: { mfaSecret?: string } = {},
) {
  const email = `vp-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await server.db
    .insert(s.users)
    .values({
      role,
      email,
      fullName: `${role} tester`,
      passwordHash: await hashPassword(PASSWORD),
      ...(options.mfaSecret
        ? { mfaSecret: options.mfaSecret, mfaEnrolledAt: new Date() }
        : {}),
    })
    .returning({ id: s.users.id });
  userIds.push(user!.id);

  if (role === "locum") {
    await server.db
      .insert(s.locumProfiles)
      .values({ userId: user!.id, verification: "incomplete", baseLocation: JHB });
  }

  const response = await server.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email,
      password: PASSWORD,
    },
    headers: { "x-forwarded-for": `198.18.0.${(ipCounter += 1) % 250}` },
  });
  if (response.statusCode !== 200) {
    throw new Error(`fixture login failed (${response.statusCode}): ${response.body}`);
  }
  return { id: user!.id, accessToken: response.json().accessToken as string };
}

async function call(
  path: string,
  input: Record<string, unknown>,
  token?: string,
  method: "POST" | "GET" = "POST",
): Promise<LightMyRequestResponse> {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method === "GET") {
    return server.app.inject({
      method: "GET",
      url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
      headers,
    });
  }
  return server.app.inject({ method: "POST", url: `/trpc/${path}`, payload: input, headers });
}

describe("GATE product.verification — HTTP", () => {
  it("a locum uploads and lands in complete_unverified, not verified", async () => {
    const locum = await makeActor("locum");

    const upload = await call(
      "verification.upload",
      { type: "sapc_certificate", contentBase64: PDF, filename: "cert.pdf" },
      locum.accessToken,
    );
    expect(upload.statusCode).toBe(200);
    expect(upload.json().result.data.detectedMimeType).toBe("application/pdf");

    const status = await call("verification.myStatus", {}, locum.accessToken, "GET");
    expect(status.json().result.data.verification).toBe("complete_unverified");
  });

  it("rejects a disguised executable over HTTP", async () => {
    const locum = await makeActor("locum");
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.alloc(64),
    ]).toString("base64");

    const response = await call(
      "verification.upload",
      { type: "sapc_certificate", contentBase64: elf, filename: "certificate.pdf" },
      locum.accessToken,
    );
    // Named .pdf, declared as a certificate — refused on its bytes.
    expect(response.statusCode).toBe(400);
  });

  it("rejects an infected upload over HTTP", async () => {
    const locum = await makeActor("locum");
    const infected = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "ascii"),
      Buffer.from(EICAR_TEST_STRING, "ascii"),
    ]).toString("base64");

    const response = await call(
      "verification.upload",
      { type: "sapc_certificate", contentBase64: infected },
      locum.accessToken,
    );
    expect(response.statusCode).toBe(400);
  });

  it("refuses a NON-ADMIN any access to the review queue", async () => {
    const locum = await makeActor("locum");
    const manager = await makeActor("manager");

    expect((await call("verification.queue", {}, locum.accessToken, "GET")).statusCode).toBe(403);
    expect((await call("verification.queue", {}, manager.accessToken, "GET")).statusCode).toBe(403);
  });

  it("refuses an admin session that never satisfied MFA (defence in depth)", async () => {
    /*
     * Note what this test had to do to exist: `login` already refuses an admin
     * with no enrolled TOTP secret, so a non-MFA admin token cannot be
     * obtained through the front door at all. That is the primary control
     * working.
     *
     * The check inside adminProcedure is therefore a SECOND line, for a
     * session minted by some other route — a future SSO path, an internal
     * tool, a migration that backfills sessions. To exercise it the token is
     * forged here with mfa:false against a real session row, which is exactly
     * the state those paths could produce by accident.
     */
    const secret = generateTotpSecret();
    const admin = await makeActor("admin", { mfaSecret: secret });

    const [session] = await server.db
      .select({ id: s.sessions.id })
      .from(s.sessions)
      .where(eq(s.sessions.userId, admin.id))
      .limit(1);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const nonMfaToken = signAccessToken(
      {
        sub: admin.id,
        role: "admin",
        iat: nowSeconds,
        exp: nowSeconds + 900,
        sid: session!.id,
        mfa: false,
      },
      "test-auth-secret-at-least-32-characters-long",
    );

    // Same admin, same live session — refused purely because the session does
    // not carry the MFA claim.
    expect(
      (await call("verification.queue", {}, nonMfaToken, "GET")).statusCode,
    ).toBe(403);

    // And the properly-issued token works.
    expect(
      (await call("verification.queue", {}, admin.accessToken, "GET")).statusCode,
    ).toBe(200);
  });

  it("an MFA admin reviews, and the decision is attributable", async () => {
    const locum = await makeActor("locum");
    const secret = generateTotpSecret();
    const admin = await makeActor("admin", { mfaSecret: secret });

    const upload = await call(
      "verification.upload",
      { type: "sapc_certificate", contentBase64: PDF },
      locum.accessToken,
    );
    const documentId = upload.json().result.data.id;

    const review = await call(
      "verification.review",
      { documentId, decision: "verified", reason: "matched SAPC register" },
      admin.accessToken,
    );
    expect(review.statusCode).toBe(200);

    const history = await call(
      "verification.history",
      { userId: locum.id },
      admin.accessToken,
      "GET",
    );
    const [entry] = history.json().result.data;
    expect(entry.action).toBe("verification.verified");
    expect(entry.actorId).toBe(admin.id);
  });

  it("issues a signed download URL that carries an expiry", async () => {
    const locum = await makeActor("locum");
    await call(
      "verification.upload",
      { type: "sapc_certificate", contentBase64: PDF },
      locum.accessToken,
    );

    const mine = await call("verification.myDocuments", {}, locum.accessToken, "GET");
    const [doc] = mine.json().result.data;

    // §12.1 — retrieval expires rather than granting permanent access to a
    // document containing personal data.
    expect(doc.download.url).toMatch(/expires=\d+/);
    expect(doc.download.url).toMatch(/sig=/);
    expect(new Date(doc.download.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("lists a pending pharmacy's SAPC number and lets an MFA admin verify it directly", async () => {
    const manager = await makeActor("manager");
    const secret = generateTotpSecret();
    const admin = await makeActor("admin", { mfaSecret: secret });

    const [pharmacy] = await server.db
      .insert(s.pharmacies)
      .values({
        name: `Pharmacy ${Date.now()}`,
        addressLine: "1 Test Road",
        city: "Johannesburg",
        location: JHB,
        sapcPharmacyNumber: "PH123456",
      })
      .returning({ id: s.pharmacies.id });
    pharmacyIds.push(pharmacy!.id);
    await server.db.insert(s.pharmacyMembers).values({
      pharmacyId: pharmacy!.id,
      userId: manager.id,
      isPrimary: true,
    });

    // A non-admin cannot see it — same boundary as the locum document queue.
    expect(
      (await call("verification.queuePharmacies", {}, manager.accessToken, "GET")).statusCode,
    ).toBe(403);

    const queue = await call("verification.queuePharmacies", {}, admin.accessToken, "GET");
    expect(queue.statusCode).toBe(200);
    const row = queue.json().result.data.find((p: { pharmacyId: string }) => p.pharmacyId === pharmacy!.id);
    expect(row.sapcPharmacyNumber).toBe("PH123456");
    expect(row.verification).toBe("incomplete");

    const review = await call(
      "verification.reviewPharmacy",
      { pharmacyId: pharmacy!.id, decision: "verified" },
      admin.accessToken,
    );
    expect(review.statusCode).toBe(200);

    const [after] = await server.db
      .select({ verification: s.pharmacies.verification })
      .from(s.pharmacies)
      .where(eq(s.pharmacies.id, pharmacy!.id));
    expect(after?.verification).toBe("verified");

    // Verified pharmacies drop out of the queue.
    const queueAfter = await call("verification.queuePharmacies", {}, admin.accessToken, "GET");
    expect(
      queueAfter.json().result.data.some((p: { pharmacyId: string }) => p.pharmacyId === pharmacy!.id),
    ).toBe(false);
  });
});

describe("GATE product.profile — self-service editing", () => {
  it("a locum updates their matching profile", async () => {
    const locum = await makeActor("locum");

    const response = await call(
      "profile.updateLocumProfile",
      { baseLocation: { lng: 28.0567, lat: -26.1076 }, maxTravelKm: 40 },
      locum.accessToken,
    );
    expect(response.statusCode).toBe(200);

    const [profile] = await server.db
      .select({ maxTravelKm: s.locumProfiles.maxTravelKm })
      .from(s.locumProfiles)
      .where(eq(s.locumProfiles.userId, locum.id));
    expect(profile?.maxTravelKm).toBe(40);
  });

  it("changing the SAPC number after verification RESETS verification", async () => {
    const locum = await makeActor("locum");
    await server.db
      .update(s.locumProfiles)
      .set({ verification: "verified", verifiedAt: new Date(), sapcNumber: "P00001" })
      .where(eq(s.locumProfiles.userId, locum.id));

    const response = await call(
      "profile.updateLocumProfile",
      { sapcNumber: "P99999" },
      locum.accessToken,
    );
    expect(response.json().result.data.verificationReset).toBe(true);

    /*
     * The verification attests to a SPECIFIC registration number a human
     * checked. Letting a verified locum silently swap it would turn the
     * platform's central promise into a field they can edit — an attack
     * needing no malware and no stolen credentials.
     */
    const [profile] = await server.db
      .select({ verification: s.locumProfiles.verification })
      .from(s.locumProfiles)
      .where(eq(s.locumProfiles.userId, locum.id));
    expect(profile?.verification).toBe("complete_unverified");
  });

  it("setting availability stamps a confirmation time (§5 lapse)", async () => {
    const locum = await makeActor("locum");
    const response = await call(
      "profile.setAvailability",
      { availableFrom: new Date(Date.now() + 86_400_000).toISOString() },
      locum.accessToken,
    );
    expect(response.statusCode).toBe(200);
    // "Available" is only useful if it is current — a manager acts on it.
    expect(response.json().result.data.confirmedAt).toBeTruthy();
  });

  it("WhatsApp consent is separate and reversible (§11.4)", async () => {
    const locum = await makeActor("locum");

    await call("profile.setWhatsappConsent", { optIn: true }, locum.accessToken);
    let me = await call("profile.me", {}, locum.accessToken, "GET");
    expect(me.json().result.data.whatsappOptInAt).toBeTruthy();

    // A working opt-out path is a Meta requirement, not a nicety.
    await call("profile.setWhatsappConsent", { optIn: false }, locum.accessToken);
    me = await call("profile.me", {}, locum.accessToken, "GET");
    expect(me.json().result.data.whatsappOptOutAt).toBeTruthy();
  });

  it("a manager cannot edit a pharmacy they do not belong to", async () => {
    const owner = await makeActor("manager");
    const outsider = await makeActor("manager");

    const [pharmacy] = await server.db
      .insert(s.pharmacies)
      .values({
        name: "Owned Pharmacy",
        addressLine: "1 Road",
        city: "Johannesburg",
        location: JHB,
      })
      .returning({ id: s.pharmacies.id });
    pharmacyIds.push(pharmacy!.id);
    await server.db
      .insert(s.pharmacyMembers)
      .values({ pharmacyId: pharmacy!.id, userId: owner.id, isPrimary: true });

    const denied = await call(
      "profile.updatePharmacy",
      { pharmacyId: pharmacy!.id, name: "Hijacked" },
      outsider.accessToken,
    );
    // 404 not 403: this must not confirm which pharmacy ids exist.
    expect(denied.statusCode).toBe(404);

    const allowed = await call(
      "profile.updatePharmacy",
      { pharmacyId: pharmacy!.id, name: "Renamed By Owner" },
      owner.accessToken,
    );
    expect(allowed.statusCode).toBe(200);
  });

  it("a locum cannot reach manager-only profile routes", async () => {
    const locum = await makeActor("locum");
    expect(
      (await call("profile.myPharmacies", {}, locum.accessToken, "GET")).statusCode,
    ).toBe(403);
  });
});

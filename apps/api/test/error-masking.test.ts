import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import type { DocumentScanner } from "@locum/core";
import { loadConfig } from "../src/config";
import { buildServer, type BuiltServer } from "../src/server";
import { hashPassword } from "@locum/core";

/**
 * GATE: security.error_disclosure
 *
 * tRPC suppresses stack traces outside development but returns the thrown
 * error's MESSAGE verbatim, at every level and in production.
 *
 * Found by booting the API in production mode with the malware scanner down
 * and reading what came back to the client:
 *
 *   "clamd connection failed: connect ECONNREFUSED 127.0.0.1:3310"
 *
 * — an internal address and port, handed to any locum who happened to upload
 * during an outage. Nothing about it is specific to the scanner: an S3 failure
 * carries the bucket and key, and a Postgres error can carry a fragment of the
 * query that failed.
 *
 * The reason this is a gate rather than a one-line fix is that it is invisible
 * from inside the test suite. Every existing test asserts on status codes and
 * on domain messages, both of which stayed correct the entire time.
 */

let server: BuiltServer;
const userIds: string[] = [];

/** Throws the way a real adapter does when its dependency is unreachable. */
class ExplodingScanner implements DocumentScanner {
  async scan(): Promise<never> {
    throw new Error("clamd connection failed: connect ECONNREFUSED 10.20.1.7:3310");
  }
}

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
    { documentScanner: new ExplodingScanner() },
  );
  await server.app.ready();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, userIds));
    await server.db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, userIds));
    await server.db.delete(s.users).where(inArray(s.users.id, userIds));
  }
  await server.app.close();
  await server.client.end();
});

async function signedInLocum(): Promise<string> {
  const email = `masking-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const password = "a-sufficiently-long-test-password";

  const [user] = await server.db
    .insert(s.users)
    .values({
      email,
      fullName: "Masking Test",
      passwordHash: await hashPassword(password),
      role: "locum",
      phone: `+2782${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    })
    .returning({ id: s.users.id });

  userIds.push(user!.id);

  await server.db.insert(s.locumProfiles).values({
    userId: user!.id,
    sapcNumber: `P${Math.floor(100_000 + Math.random() * 899_999)}`,
    // The column is `verification`, and it is what locumProcedure checks —
    // an unverified locum is refused before the upload ever reaches a scanner.
    verification: "verified",
  });

  const response = await server.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });

  return (response.json() as { accessToken: string }).accessToken;
}

describe("GATE security.error_disclosure — internals stay on the server", () => {
  it("does not return an adapter's internal message to the client", async () => {
    /*
     * The assertion that would have caught this in the first place. It checks
     * for the ABSENCE of infrastructure detail, which no status-code test can
     * do — every existing test passed while this was leaking.
     */
    const token = await signedInLocum();

    const response = await server.app.inject({
      method: "POST",
      url: "/trpc/verification.upload",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "sapc_certificate",
        contentBase64: Buffer.from("%PDF-1.4\n" + " ".repeat(2000)).toString("base64"),
      },
      remoteAddress: "10.9.9.9",
    });

    expect(response.statusCode).toBe(500);

    const body = response.body;
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("10.20.1.7");
    expect(body).not.toContain("3310");
    expect(body).not.toContain("clamd");
    expect(response.json().error.message).toBe(
      "Something went wrong on our side. Please try again.",
    );
  });

  it("still tells a person what they did wrong", async () => {
    /*
     * The other half, and the reason this is not simply "mask everything".
     * Domain errors carry the product's own wording and must survive — a
     * blanket mask would turn "You have already applied for this shift" into
     * "Something went wrong", which is a worse product and a support burden.
     */
    const token = await signedInLocum();

    const response = await server.app.inject({
      method: "POST",
      url: "/trpc/booking.apply",
      headers: { authorization: `Bearer ${token}` },
      payload: { shiftId: "00000000-0000-0000-0000-000000000000" },
      remoteAddress: "10.9.9.10",
    });

    // Whatever it is, it is not the generic mask: the client is told something
    // actionable, and the domain code is still present to branch on.
    expect(response.json().error.message).not.toBe(
      "Something went wrong on our side. Please try again.",
    );
  });
});

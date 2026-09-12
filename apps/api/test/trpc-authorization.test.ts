import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { hashPassword } from "@locum/core";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: security.authorization
 *
 * §12.1 treats acting on another party's data as an authorisation boundary.
 * The cases that matter for this product are concrete:
 *
 *   - a manager must not confirm a booking on another pharmacy's shift
 *   - a locum must not confirm anything at all
 *   - a favourites-only shift must be invisible to a locum who was not saved,
 *     or the §10.1 visibility control is decorative
 *   - browse endpoints must not leak locum personal data (§12.1 scraping)
 */

const JOHANNESBURG = { lng: 28.0473, lat: -26.2041 } as const;
const PASSWORD = "s3cure-password!";

let server: BuiltServer;
const userIds: string[] = [];
const pharmacyIds: string[] = [];

interface Actor {
  readonly id: string;
  readonly email: string;
  accessToken: string;
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
  );
  await server.app.ready();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await server.db.delete(s.bookings).where(inArray(s.bookings.locumId, userIds));
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, userIds));
  }
  for (const pharmacyId of pharmacyIds) {
    await server.db.delete(s.shifts).where(eq(s.shifts.pharmacyId, pharmacyId));
    await server.db
      .delete(s.favouriteLocums)
      .where(eq(s.favouriteLocums.pharmacyId, pharmacyId));
    await server.db
      .delete(s.pharmacyMembers)
      .where(eq(s.pharmacyMembers.pharmacyId, pharmacyId));
    await server.db.delete(s.pharmacies).where(eq(s.pharmacies.id, pharmacyId));
  }
  if (userIds.length > 0) {
    await server.db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, userIds));
    await server.db.delete(s.users).where(inArray(s.users.id, userIds));
  }
  await server.app.close();
  await server.client.end();
});

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/*
 * Each actor logs in from a distinct IP.
 *
 * Not cosmetic: the per-IP login limit (§12.1) is 10/minute, and this suite
 * creates well over that many actors. Sharing one IP makes the rate limiter
 * start returning 429 partway through, which silently yields undefined access
 * tokens and failures that look like authorisation bugs. Distinct IPs are also
 * closer to reality — these are different people on different devices.
 */
let actorCounter = 0;
const nextActorIp = () => `198.51.100.${(actorCounter += 1) % 250}`;

async function makeActor(role: "manager" | "locum"): Promise<Actor> {
  const email = `trpc-${role}-${unique()}@test.invalid`;
  const [user] = await server.db
    .insert(s.users)
    .values({
      role,
      email,
      fullName: `${role} tester`,
      passwordHash: await hashPassword(PASSWORD),
    })
    .returning({ id: s.users.id });
  userIds.push(user!.id);

  if (role === "locum") {
    await server.db.insert(s.locumProfiles).values({
      userId: user!.id,
      verification: "verified",
      baseLocation: JOHANNESBURG,
      maxTravelKm: 30,
    });
  }

  const response = await server.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD },
    headers: { "x-forwarded-for": nextActorIp() },
  });

  if (response.statusCode !== 200) {
    throw new Error(
      `fixture login failed (${response.statusCode}): ${response.body}`,
    );
  }

  return { id: user!.id, email, accessToken: response.json().accessToken };
}

async function makePharmacy(managerId: string) {
  const [pharmacy] = await server.db
    .insert(s.pharmacies)
    .values({
      name: `Pharmacy ${unique()}`,
      addressLine: "1 Test Road",
      city: "Johannesburg",
      location: JOHANNESBURG,
    })
    .returning({ id: s.pharmacies.id });
  pharmacyIds.push(pharmacy!.id);

  await server.db.insert(s.pharmacyMembers).values({
    pharmacyId: pharmacy!.id,
    userId: managerId,
    isPrimary: true,
  });

  return pharmacy!.id;
}

async function makeShift(
  pharmacyId: string,
  managerId: string,
  visibility: "favourites_only" | "radius" = "favourites_only",
) {
  const [shift] = await server.db
    .insert(s.shifts)
    .values({
      pharmacyId,
      createdBy: managerId,
      startsAt: new Date(Date.now() + 48 * 3_600_000),
      endsAt: new Date(Date.now() + 56 * 3_600_000),
      hourlyRateCents: 45_000,
      status: "open",
      visibility,
      location: JOHANNESBURG,
      ...(visibility === "radius" && { radiusKm: 25 }),
    })
    .returning({ id: s.shifts.id });
  return shift!.id;
}

/**
 * Calls a tRPC procedure over HTTP with an optional bearer token.
 *
 * tRPC puts query input in the query string and mutation input in the body,
 * hence the split.
 */
/**
 * `remoteAddress` is distinct per caller.
 *
 * The API layers two limits: a global per-IP one (§12.1, credential stuffing)
 * and a per-account quota (§12.1, scraping). Driving every test from one
 * address means the IP limit fires first and masks whichever behaviour the
 * test was written to check — which is exactly what happened the first time
 * the quota tests ran: 121 browse calls exhausted the shared bucket and the
 * NEXT test failed, on an assertion about a different actor entirely.
 */
let callerSeq = 0;
const addressFor = new Map<string, string>();
function ipFor(token: string | undefined): string {
  const key = token ?? "anonymous";
  if (!addressFor.has(key)) {
    callerSeq += 1;
    addressFor.set(key, `10.${(callerSeq >> 8) & 255}.${callerSeq & 255}.1`);
  }
  return addressFor.get(key)!;
}

async function call(
  path: string,
  input: Record<string, unknown>,
  token?: string,
  method: "POST" | "GET" = "POST",
): Promise<LightMyRequestResponse> {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const remoteAddress = ipFor(token);

  if (method === "GET") {
    return await server.app.inject({
      method: "GET",
      url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
      headers,
      remoteAddress,
    });
  }
  return await server.app.inject({
    method: "POST",
    url: `/trpc/${path}`,
    payload: input,
    headers,
    remoteAddress,
  });
}

describe("GATE security.authorization — tRPC", () => {
  it("rejects an unauthenticated caller", async () => {
    const response = await call("bookings.confirm", { bookingId: crypto.randomUUID() });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a tampered bearer token", async () => {
    const manager = await makeActor("manager");
    const response = await call(
      "bookings.confirm",
      { bookingId: crypto.randomUUID() },
      `${manager.accessToken}x`,
    );
    expect(response.statusCode).toBe(401);
  });

  it("refuses a manager confirming another pharmacy's booking", async () => {
    const ownerManager = await makeActor("manager");
    const otherManager = await makeActor("manager");
    const locum = await makeActor("locum");

    const pharmacyId = await makePharmacy(ownerManager.id);
    await makePharmacy(otherManager.id); // otherManager runs a different branch
    const shiftId = await makeShift(pharmacyId, ownerManager.id);

    const [booking] = await server.db
      .insert(s.bookings)
      .values({ shiftId, locumId: locum.id, status: "requested" })
      .returning({ id: s.bookings.id });

    // The outsider is a legitimate manager with a valid session — the only
    // thing stopping them is the ownership check.
    const denied = await call(
      "bookings.confirm",
      { bookingId: booking!.id },
      otherManager.accessToken,
    );
    expect(denied.statusCode).toBe(403);

    // Nothing was confirmed as a side effect.
    const [after] = await server.db
      .select({ status: s.bookings.status })
      .from(s.bookings)
      .where(eq(s.bookings.id, booking!.id));
    expect(after?.status).toBe("requested");

    // The real owner succeeds.
    const allowed = await call(
      "bookings.confirm",
      { bookingId: booking!.id },
      ownerManager.accessToken,
    );
    expect(allowed.statusCode).toBe(200);
  });

  it("refuses a locum calling a manager-only procedure", async () => {
    const locum = await makeActor("locum");
    const response = await call(
      "bookings.confirm",
      { bookingId: crypto.randomUUID() },
      locum.accessToken,
    );
    expect(response.statusCode).toBe(403);
  });

  it("refuses a manager calling a locum-only procedure", async () => {
    const manager = await makeActor("manager");
    const response = await call("bookings.mine", {}, manager.accessToken, "GET");
    expect(response.statusCode).toBe(403);
  });

  it("denies access as soon as the session is revoked", async () => {
    const manager = await makeActor("manager");

    // Before revocation the token works.
    const before = await call("me", {}, manager.accessToken, "GET");
    expect(before.json().result.data.authenticated).toBe(true);

    await server.db
      .update(s.sessions)
      .set({ revokedAt: new Date(), revokedReason: "test" })
      .where(eq(s.sessions.userId, manager.id));

    /*
     * The access token is still cryptographically valid and unexpired. If the
     * context only verified the signature, a suspended admin would keep acting
     * for up to 15 minutes — which for this product means continuing to mark
     * employment "verified" (§12.1).
     */
    const after = await call("me", {}, manager.accessToken, "GET");
    expect(after.json().result.data.authenticated).toBe(false);
  });
});

describe("GATE product.billing_phase_1 — shift posting is not gated on a subscription", () => {
  /*
   * `canPostShifts` (packages/core/src/billing/dunning.ts) returns false for
   * any pharmacy with no subscription row at all — which, before
   * `BILLING_ENABLED` existed, was every pharmacy on day one. This test
   * exists because that bug shipped once already: a fresh pharmacy could
   * never post its first shift. The default config here has
   * `BILLING_ENABLED` unset, i.e. false, exactly like a deploy that never
   * sets it — this is what phase 1 actually runs.
   */
  it("lets a freshly registered, unsubscribed pharmacy post a shift", async () => {
    const manager = await makeActor("manager");
    const pharmacyId = await makePharmacy(manager.id);

    const response = await call(
      "shifts.create",
      {
        pharmacyId,
        startsAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 56 * 3_600_000).toISOString(),
        hourlyRateCents: 45_000,
        visibility: "favourites_only",
      },
      manager.accessToken,
    );

    expect(response.statusCode).toBe(200);
  });
});

describe("GATE security.authorization — §10.1 shift visibility", () => {
  it("hides a favourites-only shift from a locum who was not saved", async () => {
    const manager = await makeActor("manager");
    const saved = await makeActor("locum");
    const notSaved = await makeActor("locum");

    const pharmacyId = await makePharmacy(manager.id);
    const shiftId = await makeShift(pharmacyId, manager.id, "favourites_only");

    await server.db
      .insert(s.favouriteLocums)
      .values({ pharmacyId, locumId: saved.id });

    const savedView = await call("shifts.listOpenForMe", {}, saved.accessToken, "GET");
    const notSavedView = await call(
      "shifts.listOpenForMe",
      {},
      notSaved.accessToken,
      "GET",
    );

    const savedIds = savedView.json().result.data.map((r: { id: string }) => r.id);
    const notSavedIds = notSavedView.json().result.data.map((r: { id: string }) => r.id);

    // This is the whole point of §10.1: the manager chose who sees this.
    expect(savedIds).toContain(shiftId);
    expect(notSavedIds).not.toContain(shiftId);
  });

  it("shows a radius shift to a nearby locum who was never saved", async () => {
    const manager = await makeActor("manager");
    const nearby = await makeActor("locum");

    const pharmacyId = await makePharmacy(manager.id);
    const shiftId = await makeShift(pharmacyId, manager.id, "radius");

    const view = await call("shifts.listOpenForMe", {}, nearby.accessToken, "GET");
    const ids = view.json().result.data.map((r: { id: string }) => r.id);
    expect(ids).toContain(shiftId);
  });

  it("does not expose locum or manager contact details in the shift listing", async () => {
    const manager = await makeActor("manager");
    const locum = await makeActor("locum");
    const pharmacyId = await makePharmacy(manager.id);
    await makeShift(pharmacyId, manager.id, "radius");

    const view = await call("shifts.listOpenForMe", {}, locum.accessToken, "GET");
    const body = view.body;

    // §10.1 — no personal numbers are exchanged, ever. §12.1 — browse
    // endpoints are a scraping target.
    expect(body).not.toContain(manager.email);
    expect(body).not.toContain("phone");
    expect(body).not.toContain("passwordHash");
  });
});

describe("apply — errors a real person has to read", () => {
  it("says you already applied instead of naming a database constraint", async () => {
    /*
     * Regression. `bookings_one_live_request_per_locum` is a partial unique
     * index and the right place for the rule, but its violation used to reach
     * the client verbatim:
     *
     *   duplicate key value violates unique constraint
     *   "bookings_one_live_request_per_locum"
     *
     * That is what the web client rendered, to a pharmacist, the first time
     * anyone applied to a shift twice. Found by opening the app rather than by
     * any test — which is the point of having opened it.
     */
    const manager = await makeActor("manager");
    const locum = await makeActor("locum");
    const pharmacyId = await makePharmacy(manager.id);
    const shiftId = await makeShift(pharmacyId, manager.id, "radius");

    const first = await call(
      "bookings.applyToShift",
      { shiftId, idempotencyKey: crypto.randomUUID() },
      locum.accessToken,
    );
    expect(first.statusCode).toBe(200);

    // A different idempotency key: this is a genuine second application, not a
    // replayed request, so idempotency does not and should not absorb it.
    const second = await call(
      "bookings.applyToShift",
      { shiftId, idempotencyKey: crypto.randomUUID() },
      locum.accessToken,
    );

    expect(second.statusCode).toBe(409);
    const message = second.json().error.message as string;
    expect(message).toBe("You have already applied for this shift");
    expect(message).not.toMatch(/duplicate key|constraint|violates/i);
  });
});

describe("GATE security.rate_limit — §12.1 per-account quotas", () => {
  it("stops an authenticated locum enumerating the shift board", async () => {
    /*
     * §12.1 asks for rate limiting on browse "to prevent scraping of locum
     * personal data". The existing limit is per-IP, which is the right control
     * for credential stuffing and the wrong one here: a scraper is already
     * authenticated and gets a fresh IP by switching to mobile data.
     */
    const locum = await makeActor("locum");
    const { QUOTAS } = await import("@locum/core");

    let lastStatus = 200;
    for (let i = 0; i < QUOTAS.browseShifts.limit + 1; i += 1) {
      const response = await call("shifts.listOpenForMe", {}, locum.accessToken, "GET");
      lastStatus = response.statusCode;
      if (lastStatus !== 200) break;
    }

    expect(lastStatus, "browse must be capped per account").toBe(429);
  });

  it("keeps the role check that the quota middleware sits on top of", async () => {
    /*
     * Regression. The first version of `withQuota` returned its own
     * `protectedProcedure`, which silently dropped the locum-only check from
     * applyToShift — a manager could have applied to shifts. Downstream
     * verification would still have refused them, so nothing visible would
     * have broken; a rate limiter that quietly widens authorization is a very
     * bad trade for a limit.
     */
    const manager = await makeActor("manager");
    const response = await call(
      "bookings.applyToShift",
      { shiftId: "00000000-0000-0000-0000-000000000000", idempotencyKey: crypto.randomUUID() },
      manager.accessToken,
    );

    expect(response.statusCode, "a manager must not reach applyToShift").toBe(403);
  });

  it("does not limit one account because another was noisy", async () => {
    // The per-IP limit punishes a pharmacy group behind one NAT. Keying on the
    // account is what makes the limit hit the right person.
    const noisy = await makeActor("locum");
    const quiet = await makeActor("locum");
    const { QUOTAS } = await import("@locum/core");

    for (let i = 0; i < QUOTAS.browseShifts.limit + 1; i += 1) {
      const r = await call("shifts.listOpenForMe", {}, noisy.accessToken, "GET");
      if (r.statusCode !== 200) break;
    }

    const untouched = await call("shifts.listOpenForMe", {}, quiet.accessToken, "GET");
    expect(untouched.statusCode).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { confirmBooking, hashPassword } from "@locum/core";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: product.attendance (transport)
 *
 * §8 over HTTP, plus the §10.0 timesheet a pharmacy hands to payroll.
 */

const PHARMACY = { lng: 28.0473, lat: -26.2041 } as const;
const AT_THE_COUNTER = { lng: 28.0477, lat: -26.2041 } as const;
const SANDTON = { lng: 28.0567, lat: -26.1076 } as const;
const PASSWORD = "s3cure-password!";

let server: BuiltServer;
const userIds: string[] = [];
const pharmacyIds: string[] = [];
let actorCounter = 0;

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
  for (const pharmacyId of pharmacyIds) {
    const shiftRows = await server.db
      .select({ id: s.shifts.id })
      .from(s.shifts)
      .where(eq(s.shifts.pharmacyId, pharmacyId));
    const shiftIds = shiftRows.map((r) => r.id);
    if (shiftIds.length > 0) {
      const bookingRows = await server.db
        .select({ id: s.bookings.id })
        .from(s.bookings)
        .where(inArray(s.bookings.shiftId, shiftIds));
      const bookingIds = bookingRows.map((r) => r.id);
      if (bookingIds.length > 0) {
        await server.db.delete(s.checkIns).where(inArray(s.checkIns.bookingId, bookingIds));
        await server.db.delete(s.bookings).where(inArray(s.bookings.id, bookingIds));
      }
      await server.db.delete(s.shifts).where(inArray(s.shifts.id, shiftIds));
    }
    await server.db
      .delete(s.pharmacyMembers)
      .where(eq(s.pharmacyMembers.pharmacyId, pharmacyId));
    await server.db.delete(s.pharmacies).where(eq(s.pharmacies.id, pharmacyId));
  }
  if (userIds.length > 0) {
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, userIds));
    await server.db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, userIds));
    await server.db.delete(s.users).where(inArray(s.users.id, userIds));
  }
  await server.app.close();
  await server.client.end();
});

async function makeActor(role: "manager" | "locum") {
  const email = `att-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await server.db
    .insert(s.users)
    .values({ role, email, fullName: `${role}`, passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: s.users.id });
  userIds.push(user!.id);

  if (role === "locum") {
    await server.db.insert(s.locumProfiles).values({
      userId: user!.id,
      verification: "verified",
      baseLocation: PHARMACY,
    });
  }

  // Distinct IP per actor: the §12.1 per-IP login limit is 10/min and this
  // suite creates more than that.
  const response = await server.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD },
    headers: { "x-forwarded-for": `203.0.113.${(actorCounter += 1) % 250}` },
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

/** A live shift with one confirmed booking. */
async function liveShift() {
  const manager = await makeActor("manager");
  const locum = await makeActor("locum");

  const [pharmacy] = await server.db
    .insert(s.pharmacies)
    .values({
      name: `Att Pharmacy ${Date.now()}`,
      addressLine: "1 Test Road",
      city: "Johannesburg",
      location: PHARMACY,
    })
    .returning({ id: s.pharmacies.id });
  pharmacyIds.push(pharmacy!.id);

  await server.db
    .insert(s.pharmacyMembers)
    .values({ pharmacyId: pharmacy!.id, userId: manager.id, isPrimary: true });

  const [shift] = await server.db
    .insert(s.shifts)
    .values({
      pharmacyId: pharmacy!.id,
      createdBy: manager.id,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 8 * 3_600_000),
      hourlyRateCents: 45_000,
      status: "open",
      location: PHARMACY,
    })
    .returning({ id: s.shifts.id });

  const [booking] = await server.db
    .insert(s.bookings)
    .values({ shiftId: shift!.id, locumId: locum.id, status: "requested" })
    .returning({ id: s.bookings.id });

  await confirmBooking(server.db, { bookingId: booking!.id, actorId: manager.id });

  return { manager, locum, shiftId: shift!.id, bookingId: booking!.id };
}

describe("GATE product.attendance — HTTP", () => {
  it("a locum checks in and out, and the server measures the distance", async () => {
    const { locum, bookingId } = await liveShift();

    const checkedIn = await call(
      "attendance.checkIn",
      { bookingId, location: AT_THE_COUNTER, accuracyM: 10, mockLocationDetected: false },
      locum.accessToken,
    );
    expect(checkedIn.statusCode).toBe(200);
    const inData = checkedIn.json().result.data;
    expect(inData.checkInDistanceM).toBeLessThan(200);

    const checkedOut = await call(
      "attendance.checkOut",
      { bookingId, location: AT_THE_COUNTER },
      locum.accessToken,
    );
    expect(checkedOut.statusCode).toBe(200);
    expect(checkedOut.json().result.data.checkedOutAt).toBeTruthy();
  });

  it("refuses a manager trying to check in on the locum's behalf", async () => {
    const { manager, bookingId } = await liveShift();

    // The record is only evidence if one side cannot author it alone.
    const response = await call(
      "attendance.checkIn",
      { bookingId, location: AT_THE_COUNTER },
      manager.accessToken,
    );
    expect(response.statusCode).toBe(403);
  });

  it("rejects an out-of-range coordinate at the edge", async () => {
    const { locum, bookingId } = await liveShift();

    // PostGIS would normalise lng=200 rather than reject it, turning a client
    // unit bug into a plausible row in the wrong hemisphere.
    const response = await call(
      "attendance.checkIn",
      { bookingId, location: { lng: 200, lat: 0 } },
      locum.accessToken,
    );
    expect(response.statusCode).toBe(400);
  });

  it("gives the manager a timesheet with flags, and no wage figure (§10.0)", async () => {
    const { manager, locum, shiftId, bookingId } = await liveShift();

    await call(
      "attendance.checkIn",
      { bookingId, location: AT_THE_COUNTER },
      locum.accessToken,
    );
    // Checked out from Sandton — left the site early.
    await call(
      "attendance.checkOut",
      { bookingId, location: SANDTON },
      locum.accessToken,
    );

    const response = await call("attendance.timesheet", { shiftId }, manager.accessToken, "GET");
    expect(response.statusCode).toBe(200);

    const [row] = response.json().result.data;
    expect(row.minutesWorked).toBeTypeOf("number");
    expect(row.flags).toContain("check_out_far_from_site");

    /*
     * §10.0 — the platform never touches wages. The timesheet reports hours
     * and nothing that resembles an amount payable; producing one would start
     * to look like the labour broker the scope boundary exists to avoid.
     */
    const body = response.body;
    expect(body).not.toContain("amount");
    expect(body).not.toContain("payCents");
    expect(row).not.toHaveProperty("hourlyRateCents");
  });

  it("refuses a timesheet for another pharmacy's shift", async () => {
    const { shiftId } = await liveShift();
    const outsider = await makeActor("manager");

    const response = await call(
      "attendance.timesheet",
      { shiftId },
      outsider.accessToken,
      "GET",
    );
    expect(response.statusCode).toBe(404);
  });

  it("flags a confirmed booking with no attendance record at all", async () => {
    const { manager, shiftId } = await liveShift();

    // §8 is opt-in: a shift can complete with nobody checking in. That is not
    // an error, but the manager should see it.
    const response = await call("attendance.timesheet", { shiftId }, manager.accessToken, "GET");
    const [row] = response.json().result.data;
    expect(row.flags).toContain("no_attendance_record");
    expect(row.minutesWorked).toBeNull();
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import { FakeWhatsAppSender, hashPassword } from "@locum/core";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * §11.2 — confirming a booking is supposed to tell the locum they got the
 * shift. Nothing did, until now: `bookings.confirm` called `confirmBooking`
 * and returned, with no call anywhere into `sendWhatsAppMessage`. This test
 * exists so that gap cannot silently reopen.
 *
 * Own server instance, own `FakeWhatsAppSender` — `trpc-authorization.test.ts`
 * shares one server across many tests and does not expose its sender, so
 * asserting on sent messages needs a server built with a sender this file
 * holds a reference to.
 */

const JOHANNESBURG = { lng: 28.0473, lat: -26.2041 } as const;
const PASSWORD = "s3cure-password!";

const sender = new FakeWhatsAppSender();
let server: BuiltServer;
const userIds: string[] = [];
const pharmacyIds: string[] = [];

async function makeActor(role: "manager" | "locum") {
  const email = `confirm-notify-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const [user] = await server.db
    .insert(s.users)
    .values({
      role,
      email,
      fullName: `${role} tester`,
      passwordHash: await hashPassword(PASSWORD),
      // Required for sendWhatsAppMessage to actually attempt a send rather
      // than suppress for no_phone_number / no_whatsapp_consent.
      phone: `+2782${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      whatsappOptInAt: new Date(),
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
    headers: { "x-forwarded-for": `10.9.${userIds.length}.1` },
  });
  return { id: user!.id, accessToken: response.json().accessToken as string };
}

afterAll(async () => {
  if (userIds.length > 0) {
    await server.db.delete(s.whatsappMessageLog).where(inArray(s.whatsappMessageLog.userId, userIds));
    await server.db.delete(s.bookings).where(inArray(s.bookings.locumId, userIds));
    await server.db.delete(s.sessions).where(inArray(s.sessions.userId, userIds));
    await server.db.delete(s.locumProfiles).where(inArray(s.locumProfiles.userId, userIds));
  }
  for (const pharmacyId of pharmacyIds) {
    await server.db.delete(s.shifts).where(eq(s.shifts.pharmacyId, pharmacyId));
    await server.db.delete(s.pharmacyMembers).where(eq(s.pharmacyMembers.pharmacyId, pharmacyId));
    await server.db.delete(s.pharmacies).where(eq(s.pharmacies.id, pharmacyId));
  }
  if (userIds.length > 0) {
    await server.db.delete(s.users).where(inArray(s.users.id, userIds));
  }
  await server.app.close();
  await server.client.end();
});

describe("GATE product.messaging — booking confirmation notifies the locum", () => {
  it("sends booking_confirmed_v1 with the pharmacy name and formatted time", async () => {
    server = await buildServer(
      loadConfig({
        ...process.env,
        NODE_ENV: "test",
        AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
        DATABASE_URL:
          process.env["DATABASE_URL"] ??
          "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
      }),
      { whatsappSender: sender },
    );
    await server.app.ready();

    const manager = await makeActor("manager");
    const locum = await makeActor("locum");

    const [pharmacy] = await server.db
      .insert(s.pharmacies)
      .values({
        name: "Parktown Pharmacy",
        addressLine: "1 Test Road",
        city: "Johannesburg",
        location: JOHANNESBURG,
      })
      .returning({ id: s.pharmacies.id });
    pharmacyIds.push(pharmacy!.id);
    await server.db.insert(s.pharmacyMembers).values({
      pharmacyId: pharmacy!.id,
      userId: manager.id,
      isPrimary: true,
    });

    const startsAt = new Date(Date.now() + 48 * 3_600_000);
    const [shift] = await server.db
      .insert(s.shifts)
      .values({
        pharmacyId: pharmacy!.id,
        createdBy: manager.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 8 * 3_600_000),
        hourlyRateCents: 45_000,
        status: "open",
        visibility: "favourites_only",
        location: JOHANNESBURG,
      })
      .returning({ id: s.shifts.id });

    const [booking] = await server.db
      .insert(s.bookings)
      .values({ shiftId: shift!.id, locumId: locum.id, status: "requested" })
      .returning({ id: s.bookings.id });

    const response = await server.app.inject({
      method: "POST",
      url: "/trpc/bookings.confirm",
      payload: { bookingId: booking!.id },
      headers: { authorization: `Bearer ${manager.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.templateName).toBe("booking_confirmed_v1");
    expect(sender.sent[0]!.variables).toEqual(["Parktown Pharmacy", expect.any(String)]);

    const [logged] = await server.db
      .select({ templateType: s.whatsappMessageLog.templateType, status: s.whatsappMessageLog.status })
      .from(s.whatsappMessageLog)
      .where(eq(s.whatsappMessageLog.userId, locum.id));
    expect(logged?.templateType).toBe("booking_confirmed");
    expect(logged?.status).toBe("sent");
  });
});

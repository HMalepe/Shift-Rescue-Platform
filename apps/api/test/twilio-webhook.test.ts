import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { whatsappMessageLog } from "@locum/db";
import { buildServer, type BuiltServer } from "../src/server";
import { computeTwilioSignature } from "../src/twilio/signature";
import { loadConfig } from "../src/config";

/**
 * GATE: security.webhook_signature + code.idempotency (transport level)
 *
 * §11.5 requires inbound Twilio webhooks to be deduplicated on MessageSid.
 * §12.1 puts third-party webhook handling in security review scope.
 *
 * This exercises the whole path — HTTP in, signature checked, idempotency
 * applied, whatsapp_message_log updated — rather than the pieces in isolation,
 * because the interesting failures live in the wiring.
 */

const AUTH_TOKEN = "test_auth_token_do_not_use_in_production";
const BASE_URL = "http://localhost:3000";
const WEBHOOK_PATH = "/webhooks/twilio/status";

let server: BuiltServer;

function signedRequest(params: Record<string, string>) {
  return {
    method: "POST" as const,
    url: WEBHOOK_PATH,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": computeTwilioSignature(
        AUTH_TOKEN,
        `${BASE_URL}${WEBHOOK_PATH}`,
        params,
      ),
    },
    payload: new URLSearchParams(params).toString(),
  };
}

async function seedMessage(sid: string) {
  await server.db.insert(whatsappMessageLog).values({
    twilioSid: sid,
    direction: "outbound",
    status: "queued",
    templateType: "booking_confirmed",
    category: "utility",
  });
}

beforeAll(async () => {
  server = await buildServer(
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      PUBLIC_BASE_URL: BASE_URL,
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
    }),
  );
  await server.app.ready();
});

afterAll(async () => {
  await server.app.close();
  await server.client.end();
});

describe("GATE security.webhook_signature", () => {
  it("rejects a request with no signature", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        MessageSid: "SMnosig",
        MessageStatus: "delivered",
      }).toString(),
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a forged signature", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "definitelyNotAValidSignature=",
      },
      payload: new URLSearchParams({
        MessageSid: "SMforged",
        MessageStatus: "delivered",
      }).toString(),
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a signature computed over a DIFFERENT body", async () => {
    // The attack this blocks: replaying a captured valid signature against
    // tampered parameters. If the signature covered only the URL, this passes.
    const signature = computeTwilioSignature(
      AUTH_TOKEN,
      `${BASE_URL}${WEBHOOK_PATH}`,
      { MessageSid: "SMoriginal", MessageStatus: "delivered" },
    );

    const response = await server.app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      payload: new URLSearchParams({
        MessageSid: "SMtampered",
        MessageStatus: "failed",
      }).toString(),
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts a correctly signed request", async () => {
    const sid = `SMvalid${Date.now()}`;
    await seedMessage(sid);

    const response = await server.app.inject(
      signedRequest({ MessageSid: sid, MessageStatus: "delivered" }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, sid, replayed: false });

    await server.db
      .delete(whatsappMessageLog)
      .where(eq(whatsappMessageLog.twilioSid, sid));
  });
});

describe("GATE code.idempotency — Twilio retries over HTTP", () => {
  it("processes a duplicated MessageSid exactly once", async () => {
    const sid = `SMdup${Date.now()}`;
    await seedMessage(sid);

    const params = { MessageSid: sid, MessageStatus: "delivered", Price: "-0.0085" };

    const first = await server.app.inject(signedRequest(params));
    const second = await server.app.inject(signedRequest(params));

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false });

    // Twilio's retry is acknowledged, but the handler did not run again.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ replayed: true });

    const [row] = await server.db
      .select({
        status: whatsappMessageLog.status,
        priceCents: whatsappMessageLog.priceCents,
      })
      .from(whatsappMessageLog)
      .where(eq(whatsappMessageLog.twilioSid, sid));

    expect(row?.status).toBe("delivered");
    // §11.6 — spend must not double-count on a retry.
    expect(row?.priceCents).toBe(1);

    await server.db
      .delete(whatsappMessageLog)
      .where(eq(whatsappMessageLog.twilioSid, sid));
  });

  it("does not walk a status backwards when callbacks arrive out of order", async () => {
    const sid = `SMorder${Date.now()}`;
    await seedMessage(sid);

    // 'read' arrives first, then a delayed 'delivered'. Under retries this is
    // routine, and naive last-write-wins would regress the record.
    await server.app.inject(
      signedRequest({ MessageSid: sid, MessageStatus: "read" }),
    );
    await server.app.inject(
      signedRequest({ MessageSid: sid, MessageStatus: "delivered" }),
    );

    const [row] = await server.db
      .select({ status: whatsappMessageLog.status })
      .from(whatsappMessageLog)
      .where(eq(whatsappMessageLog.twilioSid, sid));

    expect(row?.status).toBe("read");

    await server.db
      .delete(whatsappMessageLog)
      .where(eq(whatsappMessageLog.twilioSid, sid));
  });

  it("acknowledges an unknown status without recording it", async () => {
    const sid = `SMunknown${Date.now()}`;
    await seedMessage(sid);

    const response = await server.app.inject(
      signedRequest({ MessageSid: sid, MessageStatus: "teleported" }),
    );

    // 200 so Twilio stops retrying something a retry cannot fix.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ignored: true });

    const [row] = await server.db
      .select({ status: whatsappMessageLog.status })
      .from(whatsappMessageLog)
      .where(eq(whatsappMessageLog.twilioSid, sid));
    expect(row?.status).toBe("queued");

    await server.db
      .delete(whatsappMessageLog)
      .where(eq(whatsappMessageLog.twilioSid, sid));
  });

  it("rejects a callback with no MessageSid", async () => {
    const response = await server.app.inject(
      signedRequest({ MessageStatus: "delivered" }),
    );
    expect(response.statusCode).toBe(400);
  });
});

describe("health", () => {
  it("reports healthy and actually touches the database", async () => {
    const response = await server.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "healthy" });
    expect(response.json().databaseLatencyMs).toBeTypeOf("number");
  });
});

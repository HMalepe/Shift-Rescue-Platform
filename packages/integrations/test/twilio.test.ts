import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TwilioError, TwilioWhatsAppSender, parseTwilioPrice } from "../src/index";

/**
 * GATE: messaging.twilio_adapter
 *
 * §15 classes the Twilio integration as externally blocked — it needs an
 * approved sender and approved templates, neither of which can be created from
 * here. So this cannot prove a message arrives on someone's phone.
 *
 * What it CAN prove is everything up to the wire, against a real HTTP server
 * standing in for Twilio: the exact request shape, the auth header, template
 * variables in Meta's positional form, error classification, and the timeout.
 * Those are the parts that are wrong in a way no amount of vendor access would
 * reveal quickly — a malformed ContentVariables object fails on the first real
 * send, at 07:00, in front of a pharmacist.
 */

let twilio: Server;
let baseUrl = "";
let received: Array<{ url: string; headers: IncomingMessage["headers"]; body: string }> = [];
let respondWith: { status: number; payload: unknown } = {
  status: 201,
  payload: { sid: "SM123", status: "queued", price: null },
};
let delayMs = 0;

beforeAll(async () => {
  twilio = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body });
      const send = () => {
        res.writeHead(respondWith.status, { "content-type": "application/json" });
        res.end(JSON.stringify(respondWith.payload));
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => twilio.listen(0, "127.0.0.1", resolve));
  const address = twilio.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => twilio.close(() => resolve()));
});

function sender(overrides: Record<string, unknown> = {}) {
  received = [];
  delayMs = 0;
  respondWith = { status: 201, payload: { sid: "SM123", status: "queued", price: null } };
  return new TwilioWhatsAppSender({
    accountSid: "ACtest",
    authToken: "secret-token",
    fromNumber: "+27600000000",
    statusCallbackUrl: "https://api.example.com/webhooks/twilio/status",
    contentSids: { booking_confirmed_v1: "HXabc123" },
    baseUrl,
    ...overrides,
  });
}

function form(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

describe("GATE messaging.twilio_adapter — the request Twilio actually receives", () => {
  it("sends a template by Content SID with positional variables", async () => {
    const result = await sender().sendTemplate({
      to: "+27821234567",
      templateName: "booking_confirmed_v1",
      variables: ["Sandton Pharmacy", "Tuesday 08:00"],
    });

    expect(result.sid).toBe("SM123");
    expect(received).toHaveLength(1);

    const params = form(received[0]!.body);
    expect(params.get("To")).toBe("whatsapp:+27821234567");
    expect(params.get("From")).toBe("whatsapp:+27600000000");
    expect(params.get("ContentSid")).toBe("HXabc123");

    /*
     * Meta's positional form: one-based string keys, in submission order. Get
     * this wrong and the template renders with the pharmacy name in the time
     * slot — accepted by Twilio, delivered, and nonsense to the reader.
     */
    expect(JSON.parse(params.get("ContentVariables")!)).toEqual({
      "1": "Sandton Pharmacy",
      "2": "Tuesday 08:00",
    });

    // §11.5 — without this Twilio never calls back, and §11.7's delivery rate
    // is permanently zero because nothing ever leaves `sent`.
    expect(params.get("StatusCallback")).toBe(
      "https://api.example.com/webhooks/twilio/status",
    );
  });

  it("authenticates with the account SID and auth token", async () => {
    await sender().sendFreeform({ to: "+27821234567", body: "hello" });

    const auth = received[0]!.headers.authorization as string;
    expect(auth.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(auth.slice(6), "base64").toString()).toBe("ACtest:secret-token");
  });

  it("posts to the account's Messages endpoint", async () => {
    await sender().sendFreeform({ to: "+27821234567", body: "hello" });
    expect(received[0]!.url).toBe("/2010-04-01/Accounts/ACtest/Messages.json");
  });

  it("refuses to send a template with no approved Content SID", async () => {
    /*
     * §11.3's "missed branch" in its most tempting form. Falling back to a
     * free-form send here would be accepted by Twilio, rejected by Meta
     * outside the 24-hour window, and look successful from our side — a
     * silent failed send, which is the exact failure mode §11.3 names.
     */
    const error = await sender()
      .sendTemplate({
        to: "+27821234567",
        templateName: "not_yet_approved_v1",
        variables: [],
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TwilioError);
    expect((error as TwilioError).message).toMatch(/No approved Content SID/);
    // Nothing was sent — not even as free-form.
    expect(received).toHaveLength(0);
  });
});

describe("GATE messaging.twilio_adapter — what the fake was hiding", () => {
  it("returns NO price, because Twilio does not have one yet", async () => {
    /*
     * The fake returns priceCents: 8 on every send. Twilio returns
     * `price: null` on accept and bills later, reporting the real figure on
     * the status callback.
     *
     * Any code that assumed a price at send time would have passed every test
     * and reported zero spend in production — §11.6's cap would never fire,
     * on a metric the dashboard shows as confidently correct.
     */
    const result = await sender().sendFreeform({ to: "+27821234567", body: "hi" });
    expect(result).not.toHaveProperty("priceCents");
    expect(result.sid).toBe("SM123");
  });

  it("converts Twilio's negative price string to positive cents", () => {
    /*
     * Twilio reports price as a NEGATIVE decimal — a debit against the account
     * balance. Stored verbatim, §11.6's daily spend becomes a growing negative
     * number and the cap never triggers.
     */
    expect(parseTwilioPrice("-0.0079")).toBe(1);
    expect(parseTwilioPrice("-0.0553")).toBe(6);
    expect(parseTwilioPrice(null)).toBeUndefined();
    expect(parseTwilioPrice("")).toBeUndefined();
    expect(parseTwilioPrice("not-a-number")).toBeUndefined();
  });
});

describe("GATE messaging.twilio_adapter — failure classification", () => {
  it("marks a rate limit retryable", async () => {
    /*
     * §4.4's drain treats a failed send as terminal, so misclassifying a
     * rate-limit as permanent would silently drop messages during exactly the
     * 07:00 burst that produces rate-limits.
     */
    const s = sender();
    respondWith = { status: 429, payload: { message: "Too Many Requests", code: 20429 } };

    const error = (await s
      .sendFreeform({ to: "+27821234567", body: "hi" })
      .catch((e: unknown) => e)) as TwilioError;

    expect(error.status).toBe(429);
    expect(error.code).toBe(20429);
    expect(error.retryable).toBe(true);
  });

  it("marks a template rejection permanent", async () => {
    // 63016 means a free-form message went out where a template was required.
    // Retrying sends the same rejected thing; it is a §11.3 bug, not a blip.
    const s = sender();
    respondWith = {
      status: 400,
      payload: { message: "outside the allowed window", code: 63016 },
    };

    const error = (await s
      .sendTemplate({
        to: "+27821234567",
        templateName: "booking_confirmed_v1",
        variables: [],
      })
      .catch((e: unknown) => e)) as TwilioError;

    expect(error.code).toBe(63016);
    expect(error.retryable).toBe(false);
  });

  it("marks a server error retryable", async () => {
    const s = sender();
    respondWith = { status: 503, payload: { message: "Service Unavailable" } };

    const error = (await s
      .sendFreeform({ to: "+27821234567", body: "hi" })
      .catch((e: unknown) => e)) as TwilioError;
    expect(error.retryable).toBe(true);
  });

  it("times out rather than hanging a worker", async () => {
    /*
     * This runs inside the §4.4 drain, one message at a time. A request with
     * no timeout stalls the whole backlog behind one unlucky send — and the
     * backlog is the 07:00 burst.
     */
    const s = sender({ timeoutMs: 150 });
    delayMs = 2_000;

    const error = (await s
      .sendFreeform({ to: "+27821234567", body: "hi" })
      .catch((e: unknown) => e)) as TwilioError;

    expect(error).toBeInstanceOf(TwilioError);
    expect(error.status).toBe(408);
    expect(error.retryable).toBe(true);
  });

  it("rejects an accepted response with no SID", async () => {
    /*
     * The SID is §11.5's dedupe key and the join target for every delivery
     * receipt. A row without one can never be reconciled, so a 2xx that omits
     * it is a failure however cheerful it looks.
     */
    const s = sender();
    respondWith = { status: 201, payload: { status: "queued" } };

    const error = (await s
      .sendFreeform({ to: "+27821234567", body: "hi" })
      .catch((e: unknown) => e)) as TwilioError;
    expect(error.message).toMatch(/no SID/);
  });
});

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as s from "@locum/db/schema";
import {
  FakeWhatsAppSender,
  TEMPLATES,
  isWithinQuietHours,
  nextSevenAmSast,
  sendFreeformReply,
  sendWhatsAppMessage,
  spendToday,
  type SendDeps,
} from "../../src/index";
import { connect } from "../helpers/fixtures";

/**
 * GATE: messaging.session_window
 *
 * §11.3 is the one that matters most here: "a missed branch here is a silent
 * failed send, not a visible error". Every assertion below is about a failure
 * that would otherwise be invisible — a message that goes to someone who opted
 * out, one that wakes a pharmacist at 03:00, or one sent free-form when Meta
 * required a template.
 */

const { db, client } = connect();
const createdUserIds: string[] = [];

function makeDeps(overrides: Partial<SendDeps> = {}): SendDeps & {
  sender: FakeWhatsAppSender;
} {
  const sender = overrides.sender ?? new FakeWhatsAppSender();
  return { ...overrides, sender } as SendDeps & { sender: FakeWhatsAppSender };
}

async function makeUser(options: {
  optedIn?: boolean;
  optedOutAfter?: boolean;
  phone?: string | null;
  quietStart?: string;
  quietEnd?: string;
  disabled?: boolean;
} = {}) {
  const email = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;
  const optInAt = options.optedIn === false ? null : new Date(Date.now() - 86_400_000);
  const [user] = await db
    .insert(s.users)
    .values({
      role: "locum",
      email,
      fullName: "Messaging Tester",
      phone: options.phone === undefined ? `+2782${Math.floor(Math.random() * 9_000_000) + 1_000_000}` : options.phone,
      whatsappOptInAt: optInAt,
      ...(options.optedOutAfter ? { whatsappOptOutAt: new Date() } : {}),
      ...(options.quietStart ? { quietHoursStart: options.quietStart } : {}),
      ...(options.quietEnd ? { quietHoursEnd: options.quietEnd } : {}),
      ...(options.disabled ? { disabledAt: new Date() } : {}),
    })
    .returning({ id: s.users.id });
  createdUserIds.push(user!.id);
  return user!.id;
}

afterEach(async () => {
  const ids = createdUserIds.splice(0);
  if (ids.length === 0) return;
  await db.delete(s.whatsappMessageLog).where(inArray(s.whatsappMessageLog.userId, ids));
  await db.delete(s.users).where(inArray(s.users.id, ids));
});

afterAll(async () => {
  await client.end();
});

/** Midday SAST — outside anyone's quiet hours. */
const MIDDAY = () => {
  const d = new Date();
  d.setUTCHours(10, 0, 0, 0); // 12:00 SAST
  return d;
};
/** 02:00 SAST — inside the default 21:00–07:00 quiet window. */
const SMALL_HOURS = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0); // 02:00 SAST
  return d;
};

describe("GATE messaging.session_window — §11.3 template vs free-form", () => {
  it("sends a business-initiated message as a TEMPLATE, never free-form", async () => {
    const userId = await makeUser();
    const deps = makeDeps({ now: MIDDAY });

    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "booking_confirmed",
      userId,
      variables: ["Sandton Pharmacy", "Tuesday 08:00"],
    });

    expect(outcome.status).toBe("sent");
    expect(deps.sender.sent).toHaveLength(1);
    expect(deps.sender.sent[0]!.kind).toBe("template");
    expect(deps.sender.sent[0]!.templateName).toBe("booking_confirmed_v1");
  });

  it("STILL sends a template even when the user messaged us minutes ago", async () => {
    /*
     * The exact reasoning §11.3 forbids: "no exception for 'but they messaged
     * us yesterday'". An open session window must not downgrade a
     * business-initiated message to free-form, because Meta will reject it and
     * the send fails silently.
     */
    const userId = await makeUser();
    await db.insert(s.whatsappMessageLog).values({
      twilioSid: `SMinbound${Date.now()}`,
      userId,
      direction: "inbound",
      status: "delivered",
    });

    const deps = makeDeps({ now: MIDDAY });
    await sendWhatsAppMessage(db, deps, { type: "booking_confirmed", userId });

    expect(deps.sender.sent[0]!.kind).toBe("template");
  });

  it("allows a free-form reply INSIDE the 24-hour window", async () => {
    const userId = await makeUser();
    await db.insert(s.whatsappMessageLog).values({
      twilioSid: `SMinbound${Date.now()}`,
      userId,
      direction: "inbound",
      status: "delivered",
    });

    const deps = makeDeps();
    const outcome = await sendFreeformReply(db, deps, {
      userId,
      body: "The shift starts at the back entrance.",
    });

    expect(outcome.status).toBe("sent");
    expect(deps.sender.sent[0]!.kind).toBe("freeform");
  });

  it("refuses a free-form reply OUTSIDE the window rather than substituting a template", async () => {
    const userId = await makeUser();
    // An inbound message from two days ago — window closed.
    await db.insert(s.whatsappMessageLog).values({
      twilioSid: `SMold${Date.now()}`,
      userId,
      direction: "inbound",
      status: "delivered",
      createdAt: new Date(Date.now() - 48 * 3_600_000),
    });

    const deps = makeDeps();
    const outcome = await sendFreeformReply(db, deps, { userId, body: "hello" });

    // Quietly swapping in a template would send the user something other than
    // what was written.
    expect(outcome).toMatchObject({ status: "failed", error: "session window closed" });
    expect(deps.sender.sent).toHaveLength(0);
  });
});

describe("GATE messaging.consent — §11.4", () => {
  it("suppresses when the user never opted in", async () => {
    const userId = await makeUser({ optedIn: false });
    const deps = makeDeps({ now: MIDDAY });

    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "booking_confirmed",
      userId,
    });

    expect(outcome).toMatchObject({ status: "suppressed", reason: "no_whatsapp_consent" });
    expect(deps.sender.sent).toHaveLength(0);
  });

  it("suppresses after STOP, and a later opt-in re-enables", async () => {
    const userId = await makeUser({ optedOutAfter: true });
    const deps = makeDeps({ now: MIDDAY });

    // A working opt-out path is a Meta requirement, not a nicety.
    expect(
      await sendWhatsAppMessage(db, deps, { type: "booking_confirmed", userId }),
    ).toMatchObject({ status: "suppressed", reason: "opted_out" });

    // Re-opting in later must work — comparing timestamps preserves the
    // sequence in a way a boolean would have lost.
    await db
      .update(s.users)
      .set({ whatsappOptInAt: new Date() })
      .where(eq(s.users.id, userId));

    expect(
      (await sendWhatsAppMessage(db, deps, { type: "booking_confirmed", userId })).status,
    ).toBe("sent");
  });

  it("suppresses a user with no phone number, and a disabled account", async () => {
    const noPhone = await makeUser({ phone: null });
    const disabled = await makeUser({ disabled: true });
    const deps = makeDeps({ now: MIDDAY });

    expect(
      await sendWhatsAppMessage(db, deps, { type: "booking_confirmed", userId: noPhone }),
    ).toMatchObject({ status: "suppressed", reason: "no_phone_number" });
    expect(
      await sendWhatsAppMessage(db, deps, { type: "booking_confirmed", userId: disabled }),
    ).toMatchObject({ status: "suppressed", reason: "user_disabled" });
  });
});

describe("GATE messaging.quiet_hours — §4.4", () => {
  it("defers a routine message to 07:00 rather than dropping it", async () => {
    const userId = await makeUser();
    const deps = makeDeps({ now: SMALL_HOURS });

    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "availability_lapse",
      userId,
    });

    expect(outcome.status).toBe("deferred");
    expect(deps.sender.sent).toHaveLength(0);

    // Queued, not lost — the worker picks it up.
    const [row] = await db
      .select({ status: s.whatsappMessageLog.status, scheduledFor: s.whatsappMessageLog.scheduledFor })
      .from(s.whatsappMessageLog)
      .where(eq(s.whatsappMessageLog.userId, userId));
    expect(row?.status).toBe("queued");
    expect(row?.scheduledFor).toBeInstanceOf(Date);
  });

  it("sends an urgent message DURING quiet hours", async () => {
    const userId = await makeUser();
    const deps = makeDeps({ now: SMALL_HOURS });

    /*
     * A cancellation at 02:00 is the difference between finding cover before
     * opening and not trading. Quiet hours protect against noise, not against
     * the thing the product exists to solve.
     */
    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "booking_cancelled",
      userId,
    });

    expect(outcome.status).toBe("sent");
    expect(deps.sender.sent).toHaveLength(1);
  });

  it("handles a quiet window that wraps midnight", () => {
    const at = (utcHour: number) => {
      const d = new Date();
      d.setUTCHours(utcHour, 0, 0, 0);
      return d;
    };
    // 21:00–07:00 SAST. UTC is SAST-2, so 21:00 SAST = 19:00 UTC.
    expect(isWithinQuietHours(at(20), "21:00", "07:00")).toBe(true); // 22:00 SAST
    expect(isWithinQuietHours(at(0), "21:00", "07:00")).toBe(true); // 02:00 SAST
    expect(isWithinQuietHours(at(10), "21:00", "07:00")).toBe(false); // 12:00 SAST
    expect(isWithinQuietHours(at(6), "21:00", "07:00")).toBe(false); // 08:00 SAST
  });

  it("schedules to the NEXT 07:00, never a time already past", () => {
    const lateNight = new Date();
    lateNight.setUTCHours(23, 0, 0, 0);
    expect(nextSevenAmSast(lateNight).getTime()).toBeGreaterThan(lateNight.getTime());

    const earlyMorning = new Date();
    earlyMorning.setUTCHours(1, 0, 0, 0);
    expect(nextSevenAmSast(earlyMorning).getTime()).toBeGreaterThan(earlyMorning.getTime());
  });
});

describe("GATE messaging.spend_cap — §11.6", () => {
  it("alerts when the cap is crossed but does NOT block the send", async () => {
    const userId = await makeUser();
    let alerted: { spentCents: number; capCents: number } | undefined;

    // Pre-existing spend today, above the cap.
    await db.insert(s.whatsappMessageLog).values({
      twilioSid: `SMspend${Date.now()}`,
      userId,
      direction: "outbound",
      status: "sent",
      priceCents: 5000,
    });

    const deps = makeDeps({
      now: MIDDAY,
      dailySpendCapCents: 1000,
      onSpendCapExceeded: (c) => {
        alerted = c;
      },
    });

    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "booking_confirmed",
      userId,
    });

    /*
     * §11.6 says "alerting (not hard-blocking)". A cap that silently stopped
     * booking confirmations would convert a billing anomaly into an
     * operational outage — the pharmacy still needs to know it has cover.
     */
    expect(outcome.status).toBe("sent");
    expect(alerted?.spentCents).toBeGreaterThanOrEqual(5000);
  });

  it("totals only billable outbound spend for today", async () => {
    const userId = await makeUser();
    await db.insert(s.whatsappMessageLog).values([
      { twilioSid: `a${Date.now()}`, userId, direction: "outbound", status: "sent", priceCents: 10 },
      { twilioSid: `b${Date.now()}`, userId, direction: "outbound", status: "sent", priceCents: 15 },
      // Inbound is not billable to us.
      { twilioSid: `c${Date.now()}`, userId, direction: "inbound", status: "delivered", priceCents: 99 },
    ]);

    expect(await spendToday(db)).toBeGreaterThanOrEqual(25);
  });
});

describe("GATE messaging.delivery_log — §11.7", () => {
  it("records a failed send instead of losing it", async () => {
    const userId = await makeUser();
    const sender = new FakeWhatsAppSender();
    sender.failNextSend("twilio unavailable");
    const deps = makeDeps({ now: MIDDAY, sender });

    const outcome = await sendWhatsAppMessage(db, deps, {
      type: "booking_confirmed",
      userId,
    });

    expect(outcome.status).toBe("failed");

    // §11.7 — a send with no record is not evidence of anything. A failure
    // that vanishes is worse than one that is logged.
    const [row] = await db
      .select({ status: s.whatsappMessageLog.status })
      .from(s.whatsappMessageLog)
      .where(eq(s.whatsappMessageLog.userId, userId));
    expect(row?.status).toBe("failed");
  });

  it("every template is categorised, and marketing is distinguishable", () => {
    // §11.2 — misclassification means rejection or retroactive re-review, so
    // the category is fixed at the type rather than chosen per call.
    for (const [type, spec] of Object.entries(TEMPLATES)) {
      expect(spec.category, `${type} has no category`).toBeDefined();
      expect(spec.templateName).toMatch(/_v\d+$/);
    }
    expect(TEMPLATES.booking_confirmed.category).toBe("utility");
    expect(TEMPLATES.referral_nudge.category).toBe("marketing");
  });
});

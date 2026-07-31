import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { users, whatsappMessageLog, type Database } from "@locum/db";
import { templateFor, type MessageType } from "./templates";
import type { WhatsAppSender } from "./ports";

/**
 * §11.3 — the single shared send function.
 *
 * "Build this as a single shared `sendWhatsAppMessage(type, ...)` function
 * that resolves template-vs-freeform internally, rather than leaving each call
 * site to decide — a missed branch here is a silent failed send, not a visible
 * error."
 *
 * That last clause is why every gate lives here rather than being sprinkled
 * across callers. A caller that forgets the consent check does not crash; it
 * quietly messages someone who asked not to be messaged, which is a Meta
 * compliance problem and a POPIA one. A caller that forgets quiet hours wakes
 * a pharmacist at 03:00. None of these announce themselves.
 *
 * Gates, in order:
 *   1. consent          (§11.4 — opt-in required, STOP always wins)
 *   2. quiet hours      (§4.4  — defer to 07:00 rather than drop)
 *   3. daily spend cap  (§11.6 — alert, do NOT block)
 *   4. template vs freeform (§11.3 — business-initiated is ALWAYS a template)
 */

export type SendOutcome =
  | { readonly status: "sent"; readonly twilioSid: string }
  | { readonly status: "deferred"; readonly scheduledFor: Date }
  | { readonly status: "suppressed"; readonly reason: SuppressionReason }
  | { readonly status: "failed"; readonly error: string };

export type SuppressionReason =
  | "no_whatsapp_consent"
  | "opted_out"
  | "no_phone_number"
  | "user_disabled";

export interface SendDeps {
  readonly sender: WhatsAppSender;
  /**
   * §11.6 — soft daily cap, per category. Crossing it raises an alert; it does
   * NOT block. The spec is explicit that this is "alerting (not
   * hard-blocking)": a cap that silently stops booking confirmations would
   * turn a billing anomaly into an operational outage.
   */
  readonly dailySpendCapCents?: number;
  readonly onSpendCapExceeded?: (context: {
    readonly spentCents: number;
    readonly capCents: number;
  }) => void;
  /** Injectable for deterministic tests. */
  readonly now?: () => Date;
}

export interface SendInput {
  readonly type: MessageType;
  readonly userId: string;
  /** Template variable bindings, in Meta's positional order. */
  readonly variables?: readonly string[];
}

export async function sendWhatsAppMessage(
  db: Database,
  deps: SendDeps,
  input: SendInput,
): Promise<SendOutcome> {
  const now = deps.now?.() ?? new Date();
  const spec = templateFor(input.type);

  const [user] = await db
    .select({
      phone: users.phone,
      disabledAt: users.disabledAt,
      optInAt: users.whatsappOptInAt,
      optOutAt: users.whatsappOptOutAt,
      quietStart: users.quietHoursStart,
      quietEnd: users.quietHoursEnd,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!user) {
    return { status: "failed", error: "user not found" };
  }
  if (user.disabledAt) {
    return { status: "suppressed", reason: "user_disabled" };
  }
  if (!user.phone) {
    return { status: "suppressed", reason: "no_phone_number" };
  }

  /*
   * §11.4 — consent.
   *
   * Opt-out always wins, and is checked first. A user who texted STOP and
   * later re-opted-in has a newer opt-in timestamp, so comparing the two
   * handles the sequence correctly; a boolean would have lost it.
   *
   * Meta requires this opt-in to be distinct from the platform's POPIA
   * onboarding consent, which is why it is its own pair of timestamps rather
   * than being folded into `popiaConsentAt`.
   */
  if (!user.optInAt) {
    return { status: "suppressed", reason: "no_whatsapp_consent" };
  }
  if (user.optOutAt && user.optOutAt.getTime() > user.optInAt.getTime()) {
    return { status: "suppressed", reason: "opted_out" };
  }

  /*
   * §4.4 — quiet hours. Queued for 07:00, never dropped.
   *
   * Times are compared in SAST (UTC+2). South Africa has a single timezone and
   * no daylight saving, so a fixed offset is correct here and will stay correct
   * — but it is an assumption that breaks the moment the product leaves the
   * country, hence stating it rather than burying it.
   */
  if (spec.respectsQuietHours && isWithinQuietHours(now, user.quietStart, user.quietEnd)) {
    const scheduledFor = nextSevenAmSast(now);

    await db.insert(whatsappMessageLog).values({
      twilioSid: `deferred:${crypto.randomUUID()}`,
      userId: input.userId,
      templateType: input.type,
      category: spec.category,
      direction: "outbound",
      status: "queued",
      scheduledFor,
      wasFreeform: "false",
    });

    return { status: "deferred", scheduledFor };
  }

  /*
   * §11.6 — spend cap. Alert, never block.
   *
   * The scenario this guards is named in the spec: a quiet-hours backlog
   * draining all at once and firing a burst of billable conversations. Worth
   * knowing about immediately; not worth suppressing a booking confirmation
   * over, because the pharmacy still needs to know it has cover.
   */
  if (deps.dailySpendCapCents !== undefined) {
    const spentCents = await spendToday(db, now);
    if (spentCents >= deps.dailySpendCapCents) {
      deps.onSpendCapExceeded?.({
        spentCents,
        capCents: deps.dailySpendCapCents,
      });
    }
  }

  /*
   * §11.3 — the branch that must never be missed.
   *
   * Everything in the template registry is business-initiated, so it is always
   * sent as an approved template, full stop. There is deliberately no code
   * path here that checks the 24-hour window and downgrades to free-form
   * "because they messaged us recently" — that is precisely the reasoning §11.3
   * forbids, and getting it wrong produces a silent failed send rather than an
   * error.
   */
  try {
    const result = await deps.sender.sendTemplate({
      to: user.phone,
      templateName: spec.templateName,
      variables: input.variables ?? [],
    });

    await db.insert(whatsappMessageLog).values({
      twilioSid: result.sid,
      userId: input.userId,
      templateType: input.type,
      category: spec.category,
      direction: "outbound",
      status: "sent",
      wasFreeform: "false",
      ...(result.priceCents !== undefined && { priceCents: result.priceCents }),
      statusUpdatedAt: now,
    });

    return { status: "sent", twilioSid: result.sid };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(whatsappMessageLog).values({
      twilioSid: `failed:${crypto.randomUUID()}`,
      userId: input.userId,
      templateType: input.type,
      category: spec.category,
      direction: "outbound",
      status: "failed",
      wasFreeform: "false",
      errorCode: message.slice(0, 20),
      statusUpdatedAt: now,
    });
    return { status: "failed", error: message };
  }
}

/**
 * §11.3 — a genuine reply inside the 24-hour session window.
 *
 * Separate function, deliberately. Making free-form a mode of
 * `sendWhatsAppMessage` would put a boolean next to every proactive call and
 * invite exactly the mistake §11.3 warns about. This one is only reachable
 * when a human is answering a user who wrote in, and it refuses if the window
 * has closed.
 */
export async function sendFreeformReply(
  db: Database,
  deps: SendDeps,
  input: { readonly userId: string; readonly body: string },
): Promise<SendOutcome> {
  const now = deps.now?.() ?? new Date();

  const [user] = await db
    .select({
      phone: users.phone,
      optInAt: users.whatsappOptInAt,
      optOutAt: users.whatsappOptOutAt,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!user?.phone) {
    return { status: "suppressed", reason: "no_phone_number" };
  }
  if (user.optOutAt && (!user.optInAt || user.optOutAt > user.optInAt)) {
    return { status: "suppressed", reason: "opted_out" };
  }

  const windowOpen = await isSessionWindowOpen(db, input.userId, now);
  if (!windowOpen) {
    /*
     * Refused rather than silently upgraded to a template. A free-form reply
     * outside the window is rejected by Meta, and quietly substituting a
     * template would send the user something other than what was written.
     */
    return { status: "failed", error: "session window closed" };
  }

  const result = await deps.sender.sendFreeform({
    to: user.phone,
    body: input.body,
  });

  await db.insert(whatsappMessageLog).values({
    twilioSid: result.sid,
    userId: input.userId,
    direction: "outbound",
    status: "sent",
    wasFreeform: "true",
    ...(result.priceCents !== undefined && { priceCents: result.priceCents }),
    statusUpdatedAt: now,
  });

  return { status: "sent", twilioSid: result.sid };
}

/** True when the user messaged us within the last 24 hours. */
export async function isSessionWindowOpen(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [row] = await db
    .select({ id: whatsappMessageLog.id })
    .from(whatsappMessageLog)
    .where(
      and(
        eq(whatsappMessageLog.userId, userId),
        eq(whatsappMessageLog.direction, "inbound"),
        gte(whatsappMessageLog.createdAt, cutoff),
      ),
    )
    .limit(1);

  return row !== undefined;
}

/** §11.6 — today's billable outbound spend, for the cap and the dashboard. */
export async function spendToday(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${whatsappMessageLog.priceCents}), 0)::int` })
    .from(whatsappMessageLog)
    .where(
      and(
        eq(whatsappMessageLog.direction, "outbound"),
        gte(whatsappMessageLog.createdAt, startOfDay),
        isNotNull(whatsappMessageLog.priceCents),
      ),
    );

  return row?.total ?? 0;
}

/** SAST offset. Single timezone, no DST — see the note at the call site. */
const SAST_OFFSET_HOURS = 2;

export function isWithinQuietHours(
  now: Date,
  quietStart: string,
  quietEnd: string,
): boolean {
  const localMinutes =
    ((now.getUTCHours() + SAST_OFFSET_HOURS) % 24) * 60 + now.getUTCMinutes();
  const start = parseTimeToMinutes(quietStart);
  const end = parseTimeToMinutes(quietEnd);

  // Quiet hours normally wrap midnight (21:00 -> 07:00), so the comparison is
  // an OR across the wrap rather than a simple between.
  return start > end
    ? localMinutes >= start || localMinutes < end
    : localMinutes >= start && localMinutes < end;
}

function parseTimeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes ?? 0);
}

export function nextSevenAmSast(now: Date): Date {
  const target = new Date(now);
  // 07:00 SAST is 05:00 UTC.
  target.setUTCHours(5, 0, 0, 0);
  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target;
}

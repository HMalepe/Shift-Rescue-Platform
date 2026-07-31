import type { WhatsappCategory } from "@locum/db";

/**
 * §11.2 — every proactive message is an approved Meta template, tagged into a
 * category at submission time.
 *
 * "Classify each message type at template-submission time, not after — a
 * template resubmitted under a different category restarts Meta's review
 * clock."
 *
 * The category therefore lives here, attached to the message type, rather than
 * being passed at each call site. A call site that could choose its own
 * category would eventually disagree with what was actually submitted to Meta,
 * and the failure mode is a rejected template days into a review cycle.
 */

export type MessageType =
  // Utility — transactional, account-related. Lower cost, faster approval.
  | "booking_confirmed"
  | "booking_cancelled"
  | "shift_starting_soon"
  | "subscription_reminder"
  | "subscription_payment_failed"
  | "availability_lapse"
  | "new_applicant"
  // Marketing — stricter opt-in enforcement, throttled harder if muted.
  | "upgrade_prompt"
  | "referral_nudge"
  | "re_engagement";

export interface TemplateSpec {
  /** Meta template name, as submitted under this sender. */
  readonly templateName: string;
  readonly category: WhatsappCategory;
  /**
   * Whether the platform initiates this message.
   *
   * §11.3: business-initiated messages "always require an approved template,
   * regardless of recency" — there is no exception for a user who happened to
   * message us yesterday. Only a genuine reply to a user-initiated
   * conversation may be free-form, and only inside the 24-hour window.
   *
   * Every entry below is business-initiated. Free-form replies are not
   * templates at all and so do not appear here; they go through
   * `sendFreeformReply`, which enforces the window separately.
   */
  readonly businessInitiated: true;
  /**
   * §4.4 — whether this may be deferred out of quiet hours.
   *
   * `false` means it goes out regardless of the hour. Only one thing qualifies:
   * a shift starting soon. Holding that until 07:00 would deliver a reminder
   * after the shift it was reminding about, which is worse than waking someone.
   */
  readonly respectsQuietHours: boolean;
}

export const TEMPLATES: Readonly<Record<MessageType, TemplateSpec>> = {
  booking_confirmed: {
    templateName: "booking_confirmed_v1",
    category: "utility",
    businessInitiated: true,
    respectsQuietHours: true,
  },
  booking_cancelled: {
    templateName: "booking_cancelled_v1",
    category: "utility",
    businessInitiated: true,
    /*
     * A cancellation is the one operational message a manager needs at 04:00 —
     * it is the difference between finding cover before opening and not
     * trading. §4.4's quiet hours protect against noise, not against the thing
     * the product exists to solve.
     */
    respectsQuietHours: false,
  },
  shift_starting_soon: {
    templateName: "shift_starting_soon_v1",
    category: "utility",
    businessInitiated: true,
    respectsQuietHours: false,
  },
  subscription_reminder: {
    templateName: "subscription_reminder_v1",
    category: "utility",
    businessInitiated: true,
    respectsQuietHours: true,
  },
  subscription_payment_failed: {
    templateName: "subscription_payment_failed_v1",
    category: "utility",
    businessInitiated: true,
    respectsQuietHours: true,
  },
  availability_lapse: {
    templateName: "availability_lapse_v1",
    category: "utility",
    businessInitiated: true,
    respectsQuietHours: true,
  },
  new_applicant: {
    templateName: "new_applicant_v1",
    category: "utility",
    businessInitiated: true,
    respectsQuietHours: true,
  },
  upgrade_prompt: {
    templateName: "upgrade_prompt_v1",
    category: "marketing",
    businessInitiated: true,
    respectsQuietHours: true,
  },
  referral_nudge: {
    templateName: "referral_nudge_v1",
    category: "marketing",
    businessInitiated: true,
    respectsQuietHours: true,
  },
  re_engagement: {
    templateName: "re_engagement_v1",
    category: "marketing",
    businessInitiated: true,
    respectsQuietHours: true,
  },
};

export function templateFor(type: MessageType): TemplateSpec {
  const spec = TEMPLATES[type];
  if (!spec) {
    // Unreachable through the type system; guards a cast at a transport edge.
    throw new Error(`no template registered for message type '${type}'`);
  }
  return spec;
}

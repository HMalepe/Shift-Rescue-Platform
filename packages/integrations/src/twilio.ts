import type { SendResult, WhatsAppSender } from "@locum/core";

/**
 * §11.1 — the real Twilio WhatsApp sender.
 *
 * Until now every message in this system went to `FakeWhatsAppSender`.
 * `assertProductionReady` refuses to boot production because of it, and
 * correctly: a worker running the fake drains the queue, marks every row
 * `sent`, and reports healthy while nothing arrives.
 *
 * ## The fake was lying about one thing, and it matters
 *
 * `SendResult.priceCents` is optional, and the fake returns `8` on every send.
 * **Twilio does not return a price when a message is accepted.** The API
 * responds with `price: null` and fills it in later, on the status callback,
 * once the message has actually been billed.
 *
 * So this adapter returns no price at all, and §11.6's spend tracking depends
 * entirely on the status webhook that already exists. That is a real behaviour
 * difference the fake had been hiding: any code that assumed a price was
 * available at send time would have worked perfectly in every test and
 * reported zero spend in production.
 *
 * ## Templates
 *
 * §11.2/§11.3: business-initiated messages are always approved templates.
 * Twilio addresses those by Content SID, not by the human-readable name the
 * template registry uses — so a name→SID map is required, and it must come
 * from configuration rather than being hard-coded, because the SIDs do not
 * exist until Meta approves each template (§15 lists that as externally
 * blocked).
 *
 * A missing SID throws rather than falling back to a free-form send. That
 * fallback is exactly the "missed branch" §11.3 warns about: it would look
 * like it worked, and Meta would reject it outside the 24-hour window.
 */

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  /** The approved sender, E.164, e.g. `+27600000000`. */
  readonly fromNumber: string;
  /**
   * §11.5 — where delivery receipts go. Without it Twilio never calls back,
   * `whatsapp_message_log` never leaves `sent`, and §11.7's delivery rate is
   * permanently zero.
   */
  readonly statusCallbackUrl: string;
  /** Template name → Twilio Content SID, from Meta approval (§15, E-blocked). */
  readonly contentSids: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** A Twilio API failure, carrying the vendor's own error code. */
export class TwilioError extends Error {
  readonly status: number;
  /** Twilio's numeric code — 63016 template rejection, 20429 rate limit, … */
  readonly code: number | undefined;
  /**
   * Whether the CONDITION is transient.
   *
   * Describes the failure, and is not an instruction to retry. The §4.4 drain
   * deliberately treats every failed send as terminal — a timeout is transient
   * *and* unsafe to repeat, because Twilio may have accepted the message and
   * only the response was lost. Retrying that produces a duplicate billable
   * WhatsApp to a human, which cannot be taken back.
   *
   * The flag exists so an operator triaging a batch of failures can tell
   * "Twilio was briefly unwell" from "this template is not approved", which
   * are the same terminal outcome and completely different problems.
   */
  readonly retryable: boolean;

  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = "TwilioError";
    this.status = status;
    this.code = code;
    this.retryable = isRetryable(status, code);
  }
}

/**
 * Which failures are worth trying again.
 *
 * The distinction is not cosmetic: §4.4's drain treats a failed send as
 * terminal, so classifying a rate-limit as permanent would silently drop
 * messages during exactly the 07:00 burst that produces rate-limits.
 */
function isRetryable(status: number, code?: number): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  /*
   * 408 is this adapter's own code for a client-side timeout. Transient — and
   * the one case where "transient" most needs the caveat above, since the
   * message may already be on its way.
   */
  if (status === 408) return true;
  // 20429: Twilio's own "too many requests" inside a 400.
  if (code === 20429) return true;
  /*
   * 63016 — "failed to send freeform message because you are outside the
   * allowed window". Not retryable: retrying sends the same rejected thing.
   * It means a template should have been used, which is a code bug rather
   * than a transient condition, and §11.3 is the section it violates.
   */
  return false;
}

export class TwilioWhatsAppSender implements WhatsAppSender {
  private readonly config: TwilioConfig;

  constructor(config: TwilioConfig) {
    this.config = config;
  }

  async sendTemplate(input: {
    to: string;
    templateName: string;
    variables: readonly string[];
  }): Promise<SendResult> {
    const contentSid = this.config.contentSids[input.templateName];

    if (!contentSid) {
      /*
       * Thrown, never downgraded to a free-form send. §11.3: "a missed branch
       * here is a silent failed send, not a visible error" — a fallback would
       * be accepted by Twilio, rejected by Meta outside the session window,
       * and look successful from here.
       */
      throw new TwilioError(
        0,
        `No approved Content SID for template "${input.templateName}". ` +
          "Templates must be approved by Meta and mapped in config before use (§11.2).",
      );
    }

    /*
     * Twilio takes template variables as a JSON object keyed by POSITION, as
     * strings: {"1": "Sandton Pharmacy", "2": "Tuesday 08:00"}. One-based, and
     * the ordering must match what was submitted to Meta — which is why the
     * registry keeps variables positional all the way from the call site
     * rather than as a named record that would need mapping here.
     */
    const contentVariables = Object.fromEntries(
      input.variables.map((value, index) => [String(index + 1), value]),
    );

    return this.post({
      To: `whatsapp:${input.to}`,
      From: `whatsapp:${this.config.fromNumber}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(contentVariables),
      StatusCallback: this.config.statusCallbackUrl,
    });
  }

  async sendFreeform(input: { to: string; body: string }): Promise<SendResult> {
    return this.post({
      To: `whatsapp:${input.to}`,
      From: `whatsapp:${this.config.fromNumber}`,
      Body: input.body,
      StatusCallback: this.config.statusCallbackUrl,
    });
  }

  private async post(params: Record<string, string>): Promise<SendResult> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const base = this.config.baseUrl ?? "https://api.twilio.com";
    const url = `${base}/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 10_000,
    );

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          /*
           * Basic auth over the account SID and auth token. `btoa` rather than
           * Buffer so this stays runtime-agnostic — packages/core is consumed
           * by the API, the worker and (eventually) an edge deployment, and a
           * Node-only primitive here would silently pin all three.
           */
          authorization: `Basic ${base64(`${this.config.accountSid}:${this.config.authToken}`)}`,
        },
        body: new URLSearchParams(params).toString(),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as {
        sid?: string;
        status?: string;
        message?: string;
        code?: number;
        price?: string | null;
      };

      if (!response.ok) {
        throw new TwilioError(
          response.status,
          payload.message ?? `Twilio returned ${response.status}`,
          payload.code,
        );
      }
      if (!payload.sid) {
        throw new TwilioError(response.status, "Twilio accepted the message but returned no SID");
      }

      /*
       * No `priceCents` — see the note at the top of this file. Twilio returns
       * `price: null` on accept and bills later; §11.6's spend figure comes
       * from the status callback. Parsing the null here and reporting 0 would
       * make the spend dashboard confidently wrong rather than empty.
       */
      return { sid: payload.sid };
    } catch (error) {
      if (error instanceof TwilioError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        /*
         * A timeout is retryable, and that is the dangerous kind of retryable:
         * Twilio may have accepted the message. The drain treats a failed send
         * as terminal precisely so this cannot become a duplicate — see the
         * reasoning in packages/core/src/messaging/drain.ts.
         */
        throw new TwilioError(408, "Twilio request timed out");
      }
      throw new TwilioError(
        0,
        error instanceof Error ? error.message : "Twilio request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function base64(value: string): string {
  if (typeof btoa === "function") return btoa(value);
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Parses the price Twilio reports on a status callback.
 *
 * Twilio sends it as a NEGATIVE decimal string — "-0.0079" — because it is a
 * debit against the account balance. Storing that verbatim would make §11.6's
 * daily spend a growing negative number and the cap would never trigger.
 * Returns cents, positive, rounded.
 */
export function parseTwilioPrice(price: string | null | undefined): number | undefined {
  if (price === null || price === undefined || price === "") return undefined;
  const value = Number(price);
  if (!Number.isFinite(value)) return undefined;
  return Math.round(Math.abs(value) * 100);
}

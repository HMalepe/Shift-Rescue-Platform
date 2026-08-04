/**
 * The Twilio boundary.
 *
 * An interface rather than a Twilio client so the §11.3 send logic is testable
 * without a Twilio account, and so §0.2's requirement that vendor failures be
 * *inducible* on staging has somewhere to plug in. The spec asks for send
 * failure, delivery-status retry, template rejection and rate-limiting to all
 * be forceable — a fake that can be told to fail is how those get exercised
 * before they happen in production.
 */

export interface SendResult {
  readonly sid: string;
  /** Twilio reports price per message; used by the §11.6 spend cap. */
  readonly priceCents?: number;
}

export interface WhatsAppSender {
  sendTemplate(input: {
    readonly to: string;
    readonly templateName: string;
    readonly variables: readonly string[];
  }): Promise<SendResult>;

  sendFreeform(input: {
    readonly to: string;
    readonly body: string;
  }): Promise<SendResult>;
}

export interface RecordedSend {
  readonly kind: "template" | "freeform";
  readonly to: string;
  readonly templateName?: string;
  readonly body?: string;
  readonly variables?: readonly string[];
}

/**
 * Test/local sender.
 *
 * Records what it was asked to send and can be told to fail, which is what
 * makes the §0.2 failure modes reproducible in a test rather than only on
 * staging.
 */
export class FakeWhatsAppSender implements WhatsAppSender {
  readonly sent: RecordedSend[] = [];
  private failNext: string | undefined;
  private counter = 0;

  /** Force the next send to throw, simulating a Twilio outage or rejection. */
  failNextSend(reason: string): void {
    this.failNext = reason;
  }

  async sendTemplate(input: {
    to: string;
    templateName: string;
    variables: readonly string[];
  }): Promise<SendResult> {
    this.throwIfArmed();
    this.sent.push({
      kind: "template",
      to: input.to,
      templateName: input.templateName,
      variables: input.variables,
    });
    return { sid: this.nextSid(), priceCents: 8 };
  }

  async sendFreeform(input: { to: string; body: string }): Promise<SendResult> {
    this.throwIfArmed();
    this.sent.push({ kind: "freeform", to: input.to, body: input.body });
    return { sid: this.nextSid(), priceCents: 5 };
  }

  private throwIfArmed(): void {
    if (this.failNext !== undefined) {
      const reason = this.failNext;
      this.failNext = undefined;
      throw new Error(reason);
    }
  }

  private nextSid(): string {
    this.counter += 1;
    return `SMfake${Date.now()}${this.counter}`;
  }
}

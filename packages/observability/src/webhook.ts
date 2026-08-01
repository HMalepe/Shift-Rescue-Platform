import type { ErrorEvent, ErrorReporter, Severity } from "./reporter";

/**
 * Delivers alerts by POSTing JSON to a configured URL.
 *
 * ## Why a webhook and not the Sentry SDK
 *
 * §15 classes this deliverable as "G (wiring) → X": the wiring can be
 * generated, and the gate closes only when a phone buzzes. A vendor SDK is
 * wiring that *cannot be exercised here at all* — no DSN, no way to prove the
 * envelope was accepted, and the first real test would be an incident. A
 * webhook is the same wiring with a receiver I can stand up and assert
 * against, and it terminates equally well at Sentry, PagerDuty's Events API,
 * Opsgenie or a Slack hook.
 *
 * The trade is real and worth naming: no breadcrumbs, no release tracking, no
 * automatic stack-frame grouping. Those are worth having, and swapping this
 * for `@sentry/node` behind the same `ErrorReporter` interface is a contained
 * change whenever a DSN exists. What matters now is that the path from "a
 * request threw" to "something outside this process knows" is real and proven.
 *
 * ## Two rules this must never break
 *
 * **It must not throw.** This runs inside a Fastify error handler and a BullMQ
 * failure handler. An alerter that throws while reporting a failure turns one
 * broken request into two, and the second has nowhere to be reported.
 *
 * **It must not block the response.** Delivery is fire-and-forget with a hard
 * timeout. A pharmacy waiting on a booking confirmation must not wait on
 * PagerDuty's TLS handshake.
 */

export interface WebhookReporterOptions {
  readonly url: string;
  readonly environment: string;
  readonly service: string;
  /** Release/commit, for correlating an alert with a deploy. */
  readonly release?: string;
  readonly timeoutMs?: number;
  /**
   * Minimum severity to deliver. `warn` in staging so the drill is visible;
   * `page` in production keeps the pager meaningful.
   */
  readonly minimumSeverity?: Severity;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch;
  /** Called when delivery itself fails — logged, never thrown. */
  readonly onDeliveryFailure?: (error: unknown) => void;
}

const SEVERITY_RANK: Record<Severity, number> = { routine: 0, warn: 1, page: 2 };

export class WebhookReporter implements ErrorReporter {
  private readonly options: WebhookReporterOptions;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: WebhookReporterOptions) {
    this.options = options;
  }

  report(event: ErrorEvent & { severity: Severity }): void {
    const minimum = this.options.minimumSeverity ?? "warn";
    if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[minimum]) return;

    const payload = {
      severity: event.severity,
      service: this.options.service,
      environment: this.options.environment,
      ...(this.options.release !== undefined && { release: this.options.release }),
      operation: event.operation,
      error: describe(event.error),
      context: event.context ?? {},
      occurredAt: new Date().toISOString(),
    };

    /*
     * Tracked rather than truly fire-and-forget. `flush()` awaits these on
     * shutdown, which is the difference between an alert about the crash that
     * killed the process and no alert about it — the interesting failures are
     * disproportionately the ones that happen just before a process dies.
     */
    const delivery = this.deliver(payload).finally(() => {
      this.inFlight.delete(delivery);
    });
    this.inFlight.add(delivery);
  }

  private async deliver(payload: unknown): Promise<void> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 5_000,
    );

    try {
      const response = await doFetch(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.options.onDeliveryFailure?.(
          new Error(`alert webhook returned ${response.status}`),
        );
      }
    } catch (error) {
      // Swallowed deliberately — see the class comment. The callback exists so
      // this is visible in logs rather than genuinely silent.
      this.options.onDeliveryFailure?.(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}

/**
 * Reduces an unknown throw to something safe to send.
 *
 * The message and stack are included; the error object is not serialised
 * wholesale. A DomainError carries a `details` bag that routinely holds row
 * ids and occasionally more, and POPIA (§10) does not cover shipping a user's
 * data to a third-party alerting vendor because it happened to be attached to
 * an exception.
 */
function describe(error: unknown): {
  name: string;
  message: string;
  code?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof candidate.code === "string" && { code: candidate.code }),
      ...(error.stack !== undefined && { stack: error.stack.slice(0, 4_000) }),
    };
  }
  return { name: "NonError", message: String(error).slice(0, 500) };
}

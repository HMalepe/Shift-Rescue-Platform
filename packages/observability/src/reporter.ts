/**
 * §0.1 — the error-reporting boundary.
 *
 * Phase 0's exit criterion is "a deliberately broken endpoint on staging
 * produces an alert", and §15 is precise about what that means: *"Sentry paging
 * a human | G (wiring) → X | The gate is that a phone buzzes."* The wiring is
 * generatable and lives here. The gate closes when someone's phone actually
 * buzzes, which no amount of code can do on its own.
 *
 * ## The design problem is not "send errors somewhere"
 *
 * It is deciding what is worth waking someone for. This service produces a
 * steady stream of perfectly correct failures — a locum applying to a filled
 * shift (409), an outsider poking at a booking (403), an expired session
 * (401). Every one is the system working. Route them all to a pager and within
 * a week the pager is muted, and then the one that mattered arrives silently.
 *
 * So the reporter takes a *severity decision*, not just an error, and the
 * decision is made in `classify` below rather than at each call site. A call
 * site that has to choose tends to choose "report it, to be safe", and safe is
 * how alert fatigue starts.
 */

export type Severity =
  /** Something is broken and a human should look now. */
  | "page"
  /** Unexpected, worth investigating, not worth a 3am phone call. */
  | "warn"
  /** Expected failure. Recorded in logs, never sent to the reporter. */
  | "routine";

export interface ErrorEvent {
  readonly error: unknown;
  /** Where it happened — a route, a job name, a domain operation. */
  readonly operation: string;
  /**
   * Structured context. Must not contain PII: this leaves the building and
   * lands in a third-party system that is not covered by the POPIA consent
   * users gave (§10). IDs are fine; names, phone numbers and message bodies
   * are not.
   */
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ErrorReporter {
  report(event: ErrorEvent & { readonly severity: Severity }): void;
  /** Flushes buffered events. Called before a process exits. */
  flush(timeoutMs?: number): Promise<void>;
}

/**
 * Domain error codes that are the system working correctly.
 *
 * Kept as an explicit list rather than "any DomainError", because that
 * distinction is not stable: a DomainError could be introduced tomorrow for a
 * condition that genuinely is an incident, and an allow-list forces whoever
 * adds it to make that call deliberately.
 */
const ROUTINE_DOMAIN_CODES: ReadonlySet<string> = new Set([
  "SHIFT_NOT_FOUND",
  "SHIFT_NOT_OPEN",
  "SHIFT_ALREADY_FILLED",
  "BOOKING_NOT_FOUND",
  "BOOKING_NOT_CONFIRMABLE",
  "LOCUM_NOT_VERIFIED",
  "NOT_SHIFT_OWNER",
  "NOT_BOOKING_OWNER",
  "NOT_BOOKING_PARTICIPANT",
  "BOOKING_NOT_CONFIRMED",
  "BOOKING_NOT_CANCELLABLE",
  "IDEMPOTENCY_KEY_REUSED",
  "INVALID_CREDENTIALS",
  "ACCOUNT_DISABLED",
  "TOO_MANY_ATTEMPTS",
  "MFA_REQUIRED",
  "MFA_INVALID",
  "MFA_ENROLMENT_REQUIRED",
  "INVALID_REFRESH_TOKEN",
  "SESSION_INVALIDATED",
  "CHECK_IN_TOO_EARLY",
  "CHECK_IN_TOO_LATE",
  "ALREADY_CHECKED_IN",
  "NOT_CHECKED_IN",
  "ALREADY_CHECKED_OUT",
  "DOCUMENT_REJECTED",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_NOT_REVIEWABLE",
  "DOCUMENT_ALREADY_REVIEWED",
  "THREAD_CLOSED",
  "INVALID_RATING",
  "SHIFT_NOT_FINISHED",
  "BOOKING_NOT_RATEABLE",
  "ALREADY_RATED",
  "SUBSCRIPTION_NOT_FOUND",
  "SUBSCRIPTION_CANCELLED",
  "CHARGE_NOT_FOUND",
]);

/**
 * Domain codes that ARE incidents despite being domain errors.
 *
 * `REFRESH_TOKEN_REUSED` is the one that matters. §12.1 treats a replayed
 * refresh token as evidence of theft and kills the session — that is the
 * system working, and it is also the single strongest signal available that
 * someone's credentials have been stolen. Filing it under "expected failure"
 * because it has a tidy error code would discard exactly the alert worth
 * having.
 */
const ALERTING_DOMAIN_CODES: ReadonlySet<string> = new Set(["REFRESH_TOKEN_REUSED"]);

/**
 * tRPC error codes that describe a *client* problem, not a server fault.
 *
 * These do not arrive as DomainErrors. `requireAuth` throws a bare
 * `TRPCError({ code: "UNAUTHORIZED" })`, and zod input validation produces
 * `BAD_REQUEST` — neither passes through packages/core at all. Without this
 * set, the very first version of `classify` paged on every unauthenticated
 * request to the API, which is to say on every expired session and every
 * scanner that ever hits the origin.
 *
 * `INTERNAL_SERVER_ERROR` is deliberately absent: that is tRPC's code for "an
 * exception escaped", and escaping exceptions are the entire point of the
 * pager.
 */
const ROUTINE_TRPC_CODES: ReadonlySet<string> = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "BAD_REQUEST",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
  "UNPROCESSABLE_CONTENT",
  "METHOD_NOT_SUPPORTED",
  "PAYLOAD_TOO_LARGE",
]);

function trpcCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "TRPCError" && typeof candidate.code === "string"
    ? candidate.code
    : undefined;
}

function domainCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (candidate.name === "DomainError" && typeof candidate.code === "string") {
    return candidate.code;
  }
  // tRPC wraps the original throw on `cause`.
  if (candidate.cause !== undefined) return domainCodeOf(candidate.cause);
  return undefined;
}

/**
 * Decides how loud an error should be.
 *
 * One function, so the policy is reviewable in one place and testable without
 * a transport.
 */
export function classify(error: unknown): Severity {
  /*
   * The domain code is checked first, because tRPC wraps DomainErrors in a
   * TRPCError — and the domain code is the more specific statement. A
   * REFRESH_TOKEN_REUSED surfacing as a TRPCError(UNAUTHORIZED) must still
   * page; reading only the outer code would file a credential theft under
   * "someone's session expired".
   */
  const code = domainCodeOf(error);

  if (code !== undefined) {
    if (ALERTING_DOMAIN_CODES.has(code)) return "page";
    if (ROUTINE_DOMAIN_CODES.has(code)) return "routine";
    /*
     * A DomainError nobody classified. Warn rather than silently routine:
     * an unclassified code is a gap in this file, and the gap should be
     * visible to whoever owns the alerts rather than to nobody.
     */
    return "warn";
  }

  const trpcCode = trpcCodeOf(error);
  if (trpcCode !== undefined && ROUTINE_TRPC_CODES.has(trpcCode)) return "routine";

  /*
   * Anything left reached here without anyone having thought about it — a null
   * dereference, a failed query, a bug. That is what the pager is for.
   */
  return "page";
}

/** Records events in memory. Used by tests and by local development. */
export class RecordingReporter implements ErrorReporter {
  readonly events: Array<ErrorEvent & { severity: Severity }> = [];

  report(event: ErrorEvent & { severity: Severity }): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }

  /** Events at or above `page`, i.e. the ones that would wake someone. */
  paging(): Array<ErrorEvent & { severity: Severity }> {
    return this.events.filter((e) => e.severity === "page");
  }
}

/**
 * Discards everything.
 *
 * The default when no DSN is configured, so local development and tests do not
 * need a Sentry account. `assertProductionReady` refuses to boot production
 * with this in place — a service that silently drops its own alerts is worse
 * than one with no alerting at all, because it looks monitored.
 */
export class NoopReporter implements ErrorReporter {
  report(): void {
    /* discarded */
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }
}

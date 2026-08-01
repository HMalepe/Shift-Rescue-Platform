import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DrillError,
  DrillGate,
  RecordingReporter,
  WebhookReporter,
  classify,
} from "../src/index";

/**
 * GATE: ops.alerting
 *
 * §0.1's exit criterion is "a deliberately broken endpoint on staging produces
 * an alert". §15 is precise about how far code can take that: *"Sentry paging
 * a human | G (wiring) → X | The gate is that a phone buzzes."*
 *
 * So this file proves the wiring — a thrown error becomes an HTTP delivery to
 * a real receiver — and cannot prove the gate. Nobody's phone buzzes in a
 * vitest run.
 *
 * The half most worth testing is not "does it send". It is **what it refuses
 * to send**. This service generates a constant stream of correct failures, and
 * an alerter that forwards all of them ends with a muted pager, which is
 * strictly worse than no alerting because it looks monitored.
 */

let receiver: Server;
let received: Array<Record<string, unknown>> = [];
let receiverUrl = "";
let respondWith = 200;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (body) received.push(JSON.parse(body));
      res.writeHead(respondWith).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  receiverUrl = `http://127.0.0.1:${address.port}/alerts`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

function reporter(overrides: Record<string, unknown> = {}) {
  received = [];
  respondWith = 200;
  return new WebhookReporter({
    url: receiverUrl,
    environment: "test",
    service: "api",
    minimumSeverity: "warn",
    ...overrides,
  });
}

/** Shaped like the DomainError that packages/core throws. */
function domainError(code: string) {
  const error = new Error(`domain: ${code}`) as Error & { code: string };
  error.name = "DomainError";
  error.code = code;
  return error;
}

describe("GATE ops.alerting — what must NOT page", () => {
  it("treats the everyday refusals as routine", () => {
    /*
     * Every one of these is the system working. A locum applying to a filled
     * shift, an outsider poking at a booking, an expired session. Route them
     * to a pager and within a week the pager is muted — and then the one that
     * mattered arrives silently.
     */
    for (const code of [
      "SHIFT_ALREADY_FILLED",
      "NOT_BOOKING_PARTICIPANT",
      "INVALID_CREDENTIALS",
      "TOO_MANY_ATTEMPTS",
      "ALREADY_RATED",
      "THREAD_CLOSED",
    ]) {
      expect(classify(domainError(code)), code).toBe("routine");
    }
  });

  it("does not deliver anything below the configured floor", async () => {
    const sink = reporter({ minimumSeverity: "page" });
    sink.report({
      error: domainError("SHIFT_ALREADY_FILLED"),
      operation: "bookings.confirm",
      severity: "routine",
    });
    sink.report({ error: new Error("boom"), operation: "x", severity: "warn" });
    await sink.flush();

    expect(received).toHaveLength(0);
  });
});

describe("GATE ops.alerting — what must page", () => {
  it("pages on anything nobody classified", () => {
    // A null dereference, a failed query, a bug. Reaching here means nobody
    // thought about it, which is what the pager is for.
    expect(classify(new TypeError("x is not a function"))).toBe("page");
    expect(classify(new Error("connection terminated unexpectedly"))).toBe("page");
    expect(classify("a string throw")).toBe("page");
  });

  it("pages on a replayed refresh token", () => {
    /*
     * The one domain error that IS an incident. §12.1 kills the session on a
     * reused refresh token — that is the system working, and simultaneously
     * the strongest available signal that someone's credentials were stolen.
     * Filing it under "expected failure" because it has a tidy code would
     * discard exactly the alert worth having.
     */
    expect(classify(domainError("REFRESH_TOKEN_REUSED"))).toBe("page");
  });

  it("warns rather than silently ignoring an unclassified domain code", () => {
    // A gap in the policy file should be visible to whoever owns the alerts,
    // not to nobody.
    expect(classify(domainError("SOME_FUTURE_CODE"))).toBe("warn");
  });

  it("unwraps a tRPC-wrapped cause", () => {
    // tRPC preserves the original throw on `cause`; classifying the wrapper
    // would page on every 409 the API returns.
    const wrapped = new Error("tRPC") as Error & { cause: unknown };
    wrapped.cause = domainError("SHIFT_ALREADY_FILLED");
    expect(classify(wrapped)).toBe("routine");
  });
});

describe("GATE ops.alerting — delivery", () => {
  it("delivers a page to a real receiver", async () => {
    const sink = reporter();
    sink.report({
      error: new DrillError("wiring check"),
      operation: "GET /__drill/boom",
      context: { requestId: "abc123" },
      severity: "page",
    });
    await sink.flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      severity: "page",
      service: "api",
      environment: "test",
      operation: "GET /__drill/boom",
      context: { requestId: "abc123" },
    });
    expect((received[0]!["error"] as { name: string }).name).toBe("DrillError");
  });

  it("never throws when the alerting vendor is down", async () => {
    /*
     * This runs inside a Fastify error handler. An alerter that throws while
     * reporting a failure turns one broken request into two, and the second
     * has nowhere to be reported.
     */
    const failures: unknown[] = [];
    const sink = new WebhookReporter({
      url: "http://127.0.0.1:1/nope",
      environment: "test",
      service: "api",
      timeoutMs: 250,
      onDeliveryFailure: (error) => failures.push(error),
    });

    expect(() =>
      sink.report({ error: new Error("boom"), operation: "x", severity: "page" }),
    ).not.toThrow();
    await sink.flush();

    // Swallowed, but not silent.
    expect(failures.length).toBeGreaterThan(0);
  });

  it("reports a non-2xx from the receiver without throwing", async () => {
    const failures: unknown[] = [];
    const sink = reporter({ onDeliveryFailure: (e: unknown) => failures.push(e) });
    respondWith = 503;

    sink.report({ error: new Error("boom"), operation: "x", severity: "page" });
    await sink.flush();

    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("503");
  });

  it("does not ship the details bag to a third party", async () => {
    /*
     * §10/POPIA. A DomainError carries `details` that routinely holds row ids
     * and occasionally more, and the consent users gave does not cover
     * forwarding their data to an alerting vendor because it happened to be
     * attached to an exception.
     */
    const sink = reporter();
    const error = domainError("SOME_CODE") as unknown as Error & { details: unknown };
    error.details = { phone: "+27821234567", body: "call me on 082 555 1234" };

    sink.report({ error, operation: "messages.post", severity: "page" });
    await sink.flush();

    const serialised = JSON.stringify(received[0]);
    expect(serialised).not.toContain("+27821234567");
    expect(serialised).not.toContain("082 555 1234");
  });

  it("flush waits for in-flight deliveries", async () => {
    /*
     * The interesting failures are disproportionately the ones just before a
     * process dies, so shutdown must not drop them.
     */
    const sink = reporter();
    sink.report({ error: new Error("last words"), operation: "shutdown", severity: "page" });
    await sink.flush();
    expect(received).toHaveLength(1);
  });
});

describe("GATE ops.alerting — §0.1 drill gating", () => {
  it("is invisible unless explicitly enabled", () => {
    // 404, not 403: a disabled drill must be indistinguishable from a path
    // that does not exist. A 403 confirms it is real and invites a retry.
    const gate = new DrillGate({ enabled: false, secret: "s3cret-drill-key" });
    expect(gate.check("s3cret-drill-key")).toEqual({
      allowed: false,
      status: 404,
      reason: "drill_disabled",
    });
  });

  it("refuses without the secret", () => {
    /*
     * An unauthenticated drill endpoint is a way to DISABLE monitoring: fire
     * it until the team stops reading alerts.
     */
    const gate = new DrillGate({ enabled: true, secret: "s3cret-drill-key" });
    expect(gate.check(undefined).allowed).toBe(false);
    expect(gate.check("wrong").allowed).toBe(false);
    expect(gate.check("s3cret-drill-ke").allowed).toBe(false);
    expect(gate.check("s3cret-drill-keyy").allowed).toBe(false);
  });

  it("fires once, then cools down", () => {
    // A drill that pages fifty times proves the pager works and spends the
    // goodwill needed for the next real page.
    const gate = new DrillGate({
      enabled: true,
      secret: "s3cret-drill-key",
      cooldownMs: 60_000,
    });

    expect(gate.check("s3cret-drill-key", 1_000).allowed).toBe(true);
    expect(gate.check("s3cret-drill-key", 2_000)).toEqual({
      allowed: false,
      status: 429,
      reason: "cooling_down",
    });
    expect(gate.check("s3cret-drill-key", 70_000).allowed).toBe(true);
  });

  it("throws something that actually pages", () => {
    /*
     * The drill uses a plain Error, not a DomainError. `classify` routes
     * DomainErrors to `routine`, so a drill wearing a tidy error code would
     * fail to page and would have tested nothing.
     */
    expect(classify(new DrillError("end to end"))).toBe("page");
  });

  it("end to end: a drill firing reaches the receiver as a page", async () => {
    // The §0.1 wiring, start to finish, minus the human.
    const sink = reporter();
    const gate = new DrillGate({ enabled: true, secret: "s3cret-drill-key" });

    const outcome = gate.check("s3cret-drill-key");
    expect(outcome.allowed).toBe(true);

    const error = new DrillError("phase 0 exit criterion");
    sink.report({ error, operation: "GET /__drill/boom", severity: classify(error) });
    await sink.flush();

    expect(received).toHaveLength(1);
    expect(received[0]!["severity"]).toBe("page");
  });
});

describe("GATE ops.alerting — the recording reporter", () => {
  it("separates paging events from the rest", () => {
    const sink = new RecordingReporter();
    sink.report({ error: new Error("a"), operation: "x", severity: "page" });
    sink.report({ error: new Error("b"), operation: "y", severity: "warn" });
    expect(sink.events).toHaveLength(2);
    expect(sink.paging()).toHaveLength(1);
  });
});

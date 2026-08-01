import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordingReporter } from "@locum/observability";
import { buildServer, type BuiltServer } from "../src/server";
import { loadConfig } from "../src/config";

/**
 * GATE: ops.alerting (API surface)
 *
 * §0.1's exit criterion — "a deliberately broken endpoint on staging produces
 * an alert" — exercised through the real Fastify instance rather than against
 * the reporter in isolation.
 *
 * What this can prove: a request to the drill path produces an alert event
 * with `page` severity, and the everyday refusals do not. What it cannot
 * prove, per §15, is that a phone buzzes. That needs staging, a real webhook,
 * and someone on call.
 */

const DRILL_SECRET = "drill-secret-at-least-16-chars";
let server: BuiltServer;
let reporter: RecordingReporter;

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    NODE_ENV: "test",
    AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
    DATABASE_URL:
      process.env["DATABASE_URL"] ??
      "postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev",
    DRILL_ENABLED: "true",
    DRILL_SECRET,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

beforeAll(async () => {
  reporter = new RecordingReporter();
  server = await buildServer(config(), { reporter });
  await server.app.ready();
});

afterAll(async () => {
  await server.app.close();
  await server.client.end();
});

describe("GATE ops.alerting — §0.1 drill through the API", () => {
  it("fires, fails deliberately, and pages", async () => {
    reporter.events.length = 0;

    const response = await server.app.inject({
      method: "POST",
      url: "/__drill/boom",
      headers: { "x-drill-secret": DRILL_SECRET },
    });

    // The endpoint's job is to break. A 200 here would mean it did not.
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("drill_fired");

    const paged = reporter.paging();
    expect(paged, "the drill must produce a paging alert").toHaveLength(1);
    expect(paged[0]!.operation).toBe("POST /__drill/boom");
    expect((paged[0]!.error as Error).name).toBe("DrillError");
  });

  it("cools down rather than allowing a flood", async () => {
    // The first firing above consumed the window. A drill that can page fifty
    // times proves the pager works and spends the goodwill needed for the next
    // real page.
    const second = await server.app.inject({
      method: "POST",
      url: "/__drill/boom",
      headers: { "x-drill-secret": DRILL_SECRET },
    });
    expect(second.statusCode).toBe(429);
  });

  it("refuses without the secret", async () => {
    const response = await server.app.inject({ method: "POST", url: "/__drill/boom" });
    expect(response.statusCode).toBe(401);
  });

  it("is a 404 when disabled, indistinguishable from an absent route", async () => {
    /*
     * The configuration production actually runs. A 403 would confirm the path
     * is real and invite someone to come back with a credential.
     */
    const off = await buildServer(config({ DRILL_ENABLED: "false" }), {
      reporter: new RecordingReporter(),
    });
    await off.app.ready();

    try {
      const response = await off.app.inject({
        method: "POST",
        url: "/__drill/boom",
        headers: { "x-drill-secret": DRILL_SECRET },
      });
      expect(response.statusCode).toBe(404);

      // ...and identical to a path that genuinely does not exist.
      const absent = await off.app.inject({ method: "POST", url: "/__drill/nope" });
      expect(absent.statusCode).toBe(404);
    } finally {
      await off.app.close();
      await off.client.end();
    }
  });
});

describe("GATE ops.alerting — the pager stays quiet for correct behaviour", () => {
  it("does not alert on an unauthenticated tRPC call", async () => {
    /*
     * The failure mode this whole design guards against. An API that pages on
     * every 401 and 409 trains its team to ignore the pager, and then the one
     * that mattered arrives silently.
     */
    reporter.events.length = 0;

    const response = await server.app.inject({
      method: "POST",
      url: "/trpc/bookings.confirm",
      payload: { bookingId: "00000000-0000-0000-0000-000000000000" },
    });

    expect(response.statusCode).toBe(401);
    expect(reporter.paging(), "a 401 is not an incident").toHaveLength(0);
  });

  it("does not alert on a bad login", async () => {
    reporter.events.length = 0;

    const response = await server.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@test.invalid", password: "wrong-password-here" },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(reporter.paging()).toHaveLength(0);
  });
});

describe("GATE ops.alerting — production refuses to boot unmonitored", () => {
  it("refuses production with no alert sink", async () => {
    const { assertProductionReady } = await import("../src/config");
    expect(() =>
      assertProductionReady(
        config({ NODE_ENV: "production", DRILL_ENABLED: "false" }),
        {},
      ),
    ).toThrow(/ALERT_WEBHOOK_URL/);
  });

  it("refuses production with the drill enabled", async () => {
    const { assertProductionReady } = await import("../src/config");
    expect(() =>
      assertProductionReady(
        config({
          NODE_ENV: "production",
          ALERT_WEBHOOK_URL: "https://alerts.example.com/hook",
          PUBLIC_BASE_URL: "https://api.example.com",
        }),
        {},
      ),
    ).toThrow(/DRILL_ENABLED/);
  });
});

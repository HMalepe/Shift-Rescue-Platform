import { describe, expect, it } from "vitest";
import { assertWorkerProductionReady, loadWorkerConfig } from "../src/config";

/**
 * GATE: worker.production_readiness
 *
 * `assertWorkerProductionReady` had no test coverage at all before this file,
 * for either guard — and one of the two guards it exists to check
 * (`usingFakePaymentProvider`) was, until this same change, wired in
 * `main.ts` as a HARDCODED `true` regardless of whether Payfast was actually
 * configured. The check itself was correct; nothing was computing the value
 * it needed to see. A test on the check alone would have kept passing
 * throughout — the bug was entirely in the wiring above it — so this also
 * exists to make the boundary between "the guard works" and "the guard was
 * told the truth" visible as two separate things.
 */

function config(overrides: Record<string, string> = {}) {
  return loadWorkerConfig({
    DATABASE_URL: "postgresql://unused",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

describe("GATE worker.production_readiness", () => {
  it("does nothing outside production", () => {
    expect(() =>
      assertWorkerProductionReady(config({ NODE_ENV: "development" }), {
        usingFakeSender: true,
        usingFakePaymentProvider: true,
      }),
    ).not.toThrow();
  });

  it("refuses production with the fake WhatsApp sender", () => {
    expect(() =>
      assertWorkerProductionReady(
        config({ NODE_ENV: "production", ALERT_WEBHOOK_URL: "https://alerts.example.com" }),
        { usingFakeSender: true, usingFakePaymentProvider: false },
      ),
    ).toThrow(/WhatsApp sender is the in-memory fake/);
  });

  it("refuses production with the fake payment provider", () => {
    /*
     * The branch that was previously unreachable in practice: main.ts always
     * passed `true` here, so this problem was always reported, correctly,
     * for a reason that had nothing to do with whether Payfast was actually
     * configured.
     */
    expect(() =>
      assertWorkerProductionReady(
        config({ NODE_ENV: "production", ALERT_WEBHOOK_URL: "https://alerts.example.com" }),
        { usingFakeSender: false, usingFakePaymentProvider: true },
      ),
    ).toThrow(/payment provider is the in-memory fake/);
  });

  it("refuses production with no alert sink", () => {
    // The worker needs this more than the API does: an API with no alerting
    // still has users who complain, and a worker has nobody at all.
    expect(() =>
      assertWorkerProductionReady(config({ NODE_ENV: "production" }), {
        usingFakeSender: false,
        usingFakePaymentProvider: false,
      }),
    ).toThrow(/ALERT_WEBHOOK_URL is unset/);
  });

  it("boots production when everything is real", () => {
    expect(() =>
      assertWorkerProductionReady(
        config({ NODE_ENV: "production", ALERT_WEBHOOK_URL: "https://alerts.example.com" }),
        { usingFakeSender: false, usingFakePaymentProvider: false },
      ),
    ).not.toThrow();
  });
});

describe("GATE worker.config — TWILIO_WHATSAPP_FROM / TWILIO_FROM_NUMBER alias", () => {
  /*
   * apps/api used to require TWILIO_FROM_NUMBER for this exact value while
   * this config required TWILIO_WHATSAPP_FROM — a real footgun on Railway,
   * where variables are copied to each service by hand. Both names now
   * resolve to the same field on both services.
   */
  it("reads the canonical name directly", () => {
    expect(config({ TWILIO_WHATSAPP_FROM: "whatsapp:+27000000001" }).TWILIO_WHATSAPP_FROM).toBe(
      "whatsapp:+27000000001",
    );
  });

  it("falls back to the legacy TWILIO_FROM_NUMBER name when canonical is unset", () => {
    expect(config({ TWILIO_FROM_NUMBER: "whatsapp:+27000000002" }).TWILIO_WHATSAPP_FROM).toBe(
      "whatsapp:+27000000002",
    );
  });

  it("prefers the canonical name when both are set", () => {
    expect(
      config({
        TWILIO_WHATSAPP_FROM: "whatsapp:+27000000001",
        TWILIO_FROM_NUMBER: "whatsapp:+27000000002",
      }).TWILIO_WHATSAPP_FROM,
    ).toBe("whatsapp:+27000000001");
  });

  it("does not leak the legacy field name into the parsed config", () => {
    expect(
      "TWILIO_FROM_NUMBER" in config({ TWILIO_FROM_NUMBER: "whatsapp:+27000000002" }),
    ).toBe(false);
  });

  it("is undefined when neither name is set", () => {
    expect(config({}).TWILIO_WHATSAPP_FROM).toBeUndefined();
  });
});

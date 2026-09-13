import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

/**
 * GATE: api.config — TWILIO_WHATSAPP_FROM / TWILIO_FROM_NUMBER alias
 *
 * This config used to require TWILIO_FROM_NUMBER for the WhatsApp sender
 * number while apps/worker's config required TWILIO_WHATSAPP_FROM for the
 * identical value — a real footgun on Railway, where variables are copied to
 * each service by hand rather than shared: set the sender under one name on
 * one service and the other silently boots with it unset. Both names now
 * resolve to the same field on both services; mirrors
 * apps/worker/test/config.test.ts's coverage of the same alias.
 */

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: "postgresql://unused",
    AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

describe("GATE api.config — TWILIO_WHATSAPP_FROM / TWILIO_FROM_NUMBER alias", () => {
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

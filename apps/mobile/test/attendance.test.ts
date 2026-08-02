import { describe, expect, it } from "vitest";
import { buildAttendanceSignals, type CapturedPosition } from "../src/lib/attendance";

/**
 * GATE: product.anti_spoofing (partial)
 *
 * §16 is unambiguous that this gate cannot close here: *"At least one physical
 * Android device with a mock-location app installed and active. Emulator
 * confirmation is explicitly insufficient — the signals being captured are
 * precisely the ones an emulator misrepresents."*
 *
 * So this file tests the half that hardware does not decide: given a position,
 * what do we send? An emulator would lie about `mocked`; it would not change
 * what `buildAttendanceSignals` does with the value. Splitting the logic out of
 * the device call is what makes that half testable at all, and it is why
 * `location.ts` is deliberately thin.
 *
 * The test that matters most is the iOS one. A platform that cannot answer the
 * question must not be recorded as having answered it "no".
 */

const JHB: CapturedPosition["coords"] = {
  longitude: 28.0473,
  latitude: -26.2041,
  accuracy: 12,
};

function position(overrides: Partial<CapturedPosition> = {}): CapturedPosition {
  return { coords: JHB, timestamp: 1_700_000_000_000, ...overrides };
}

describe("GATE product.anti_spoofing — what reaches the server", () => {
  it("sends the mock flag on Android", () => {
    // The single capability Expo was chosen for on day one.
    const signals = buildAttendanceSignals(
      position({ mocked: true }),
      "android",
      1_700_000_000_000,
    );

    expect(signals.mockLocationDetected).toBe(true);
    expect(signals.deviceSignals["anomalies"]).toContain("mock_provider");
  });

  it("sends false on Android when the platform says the fix is genuine", () => {
    const signals = buildAttendanceSignals(
      position({ mocked: false }),
      "android",
      1_700_000_000_000,
    );
    expect(signals.mockLocationDetected).toBe(false);
    expect(signals.deviceSignals["mockDetectionAvailable"]).toBe(true);
  });

  it("sends NOTHING on iOS rather than a reassuring false", () => {
    /*
     * The most important assertion in this file.
     *
     * iOS has no `isFromMockProvider()`, so `mocked` is undefined whether or
     * not the location is spoofed. A naive `mocked ?? false` would convert
     * "unknowable" into "clean" for every iPhone user, and the resulting
     * attendance record would look BETTER evidenced than an honest Android one
     * — which is exactly backwards, and would mislead whoever adjudicates a
     * dispute years later.
     *
     * The API distinguishes absent from false. This is the client half of
     * honouring that.
     */
    const signals = buildAttendanceSignals(position(), "ios", 1_700_000_000_000);

    expect(signals).not.toHaveProperty("mockLocationDetected");
    expect(signals.deviceSignals["mockDetectionAvailable"]).toBe(false);
    expect(signals.deviceSignals["anomalies"]).toContain("mock_detection_unavailable");
  });

  it("does not trust a `mocked` value from a platform that cannot produce one", () => {
    // Defensive: if a future SDK sets `mocked` on iOS, it is not the Android
    // signal and must not be reported as one.
    const signals = buildAttendanceSignals(
      position({ mocked: false }),
      "ios",
      1_700_000_000_000,
    );
    expect(signals).not.toHaveProperty("mockLocationDetected");
  });

  it("never computes distance on the device", () => {
    /*
     * §8 wants attendance to be evidence. A distance calculated on the phone
     * is a number the phone chose; the server measures the claimed coordinate
     * against the pharmacy's stored location.
     */
    const signals = buildAttendanceSignals(position(), "android");
    expect(JSON.stringify(signals)).not.toMatch(/distance/i);
    expect(signals.location).toEqual({ lng: 28.0473, lat: -26.2041 });
  });

  it("flags an implausibly precise fix without refusing it", () => {
    /*
     * Mock-location apps often report a perfect fix, because they are reading
     * a number out of a text box. It is a note for a reviewer and nothing
     * more — §8: "a false positive that voids a real pharmacist's shift is
     * worse than a missed spoof".
     */
    const signals = buildAttendanceSignals(
      position({ coords: { ...JHB, accuracy: 1 }, mocked: false }),
      "android",
      1_700_000_000_000,
    );

    expect(signals.deviceSignals["anomalies"]).toContain("implausible_accuracy");
    // Still a complete, sendable check-in.
    expect(signals.location).toBeDefined();
    expect(signals.accuracyM).toBe(1);
  });

  it("flags a stale fix", () => {
    // A cached position from this morning is not evidence of being at the
    // pharmacy now, which is the entire claim a check-in makes.
    const signals = buildAttendanceSignals(
      position({ mocked: false }),
      "android",
      1_700_000_000_000 + 10 * 60_000,
    );
    expect(signals.deviceSignals["anomalies"]).toContain("stale_fix");
    expect(signals.deviceSignals["elapsedSinceFixMs"]).toBe(600_000);
  });

  it("reports no anomalies for an ordinary Android check-in", () => {
    // The common case must be quiet, or the anomaly list means nothing.
    const signals = buildAttendanceSignals(
      position({ mocked: false }),
      "android",
      1_700_000_000_000 + 5_000,
    );
    expect(signals.deviceSignals["anomalies"]).toEqual([]);
  });

  it("omits accuracy rather than inventing one", () => {
    const signals = buildAttendanceSignals(
      position({ coords: { ...JHB, accuracy: null }, mocked: false }),
      "android",
    );
    expect(signals).not.toHaveProperty("accuracyM");
  });
});

/**
 * §8/§16 — the reason this app exists.
 *
 * Expo was chosen on day one for exactly one capability: Android's
 * `isFromMockProvider()`. A web client cannot produce it, and the web
 * `CheckInForm` in `apps/web` deliberately sends nothing in its place rather
 * than sending `false` — because the API distinguishes *absent* from *false*,
 * and `false` is an assertion that a check was performed.
 *
 * This file is where that check is actually performed.
 *
 * ## What is captured and what it is worth
 *
 * §8 keeps these as *signals*, not verdicts, and that framing is load-bearing:
 * "a false positive that voids a real pharmacist's shift is worse than a missed
 * spoof". Nothing here refuses a check-in. It attaches evidence, and a human
 * adjudicates a dispute later with better information than they would
 * otherwise have had.
 *
 *   - `mockLocationDetected` — Android's own flag. Strong, and trivially
 *     defeated by a rooted device, which is why it is not the only signal.
 *   - `accuracyM` — a spoofed fix is frequently implausibly precise. A
 *     reported accuracy of 1 m on a phone indoors in a dispensary is not
 *     evidence of fraud, but it is unusual enough to record.
 *   - `locationProvider` — which provider produced the fix.
 *   - `elapsedSinceFixMs` — how stale the reading was. A cached fix from this
 *     morning is not evidence of being at the pharmacy now.
 *
 * ## What is NOT done here
 *
 * The distance from the pharmacy is not computed on the device. §8's whole
 * point is that attendance is evidence, and a distance calculated on a phone
 * is a number the phone chose. The client sends a claimed coordinate; the
 * server measures it against the pharmacy's stored location.
 *
 * ## The honest limit
 *
 * §16 is explicit that this cannot be verified without hardware: *"At least
 * one physical Android device with a mock-location app installed and active.
 * Emulator confirmation is explicitly insufficient — the signals being
 * captured are precisely the ones an emulator misrepresents."*
 *
 * So this code is written, testable in its logic, and **unproven in the only
 * way that counts**. The gate stays open until someone stands in a pharmacy
 * with a mock-location app running and watches the flag arrive.
 */

export interface CapturedPosition {
  readonly coords: {
    readonly longitude: number;
    readonly latitude: number;
    readonly accuracy: number | null;
  };
  readonly timestamp: number;
  /** Android only; `undefined` on iOS and web. */
  readonly mocked?: boolean;
}

export interface AttendanceSignals {
  readonly location: { readonly lng: number; readonly lat: number };
  readonly accuracyM?: number;
  /**
   * Present ONLY when the platform can actually answer the question.
   *
   * On iOS this stays undefined: iOS has no equivalent API, and reporting
   * `false` would tell the server "checked, clean" when nothing was checked.
   * The server's schema makes that distinction and this is the client half of
   * honouring it.
   */
  readonly mockLocationDetected?: boolean;
  readonly deviceSignals: Readonly<Record<string, unknown>>;
}

export type Platform = "android" | "ios" | "unknown";

/**
 * Turns a platform position into what the API accepts.
 *
 * Pure, so the signal rules can be tested without a device — which is the only
 * part of §16 that CAN be tested without a device. What an emulator would get
 * wrong is the value of `mocked`, not what we do with it.
 */
export function buildAttendanceSignals(
  position: CapturedPosition,
  platform: Platform,
  now: number = Date.now(),
): AttendanceSignals {
  const accuracy = position.coords.accuracy;
  const elapsedSinceFixMs = Math.max(0, now - position.timestamp);

  /*
   * Only Android can answer this. `position.mocked` is `undefined` on iOS
   * whether or not the location is spoofed, so a naive `mocked ?? false`
   * would quietly convert "unknowable" into "clean" for every iPhone user —
   * and the resulting attendance record would look better-evidenced than the
   * Android one that honestly reported nothing.
   */
  const canDetectMocking = platform === "android" && typeof position.mocked === "boolean";

  return {
    location: { lng: position.coords.longitude, lat: position.coords.latitude },
    ...(accuracy !== null && { accuracyM: Math.round(accuracy) }),
    ...(canDetectMocking && { mockLocationDetected: position.mocked }),
    deviceSignals: {
      platform,
      elapsedSinceFixMs,
      /*
       * Recorded so a reviewer can tell "this device reported no mocking" from
       * "this device cannot report mocking". Without it those two are the same
       * absent field, and only one of them is reassuring.
       */
      mockDetectionAvailable: canDetectMocking,
      ...(accuracy !== null && { reportedAccuracyM: accuracy }),
      /*
       * §8 keeps these as signals for a human, so the *reasons* travel with
       * them rather than a score. A reviewer reading "implausible_accuracy"
       * can disagree with it; they cannot disagree with 0.82.
       */
      anomalies: detectAnomalies(accuracy, elapsedSinceFixMs, canDetectMocking, position.mocked),
    },
  };
}

/**
 * Notes worth a reviewer's attention. Never a refusal.
 *
 * Deliberately conservative. Every one of these fires on innocent behaviour
 * some of the time, and an attendance system that voids real shifts on a
 * heuristic is worse than one that occasionally misses a spoof — §8 says so
 * directly.
 */
function detectAnomalies(
  accuracy: number | null,
  elapsedSinceFixMs: number,
  canDetectMocking: boolean,
  mocked: boolean | undefined,
): string[] {
  const anomalies: string[] = [];

  if (canDetectMocking && mocked === true) {
    anomalies.push("mock_provider");
  }

  /*
   * Sub-3-metre accuracy indoors is achievable outdoors under an open sky and
   * unusual inside a dispensary. Mock-location apps commonly report a perfect
   * fix because they are reading a number out of a text box.
   */
  if (accuracy !== null && accuracy > 0 && accuracy < 3) {
    anomalies.push("implausible_accuracy");
  }

  /*
   * A fix older than two minutes was not taken at the door. The capture asks
   * for a fresh one, so a stale reading means either a slow GPS lock — common
   * and innocent — or a supplied position.
   */
  if (elapsedSinceFixMs > 120_000) {
    anomalies.push("stale_fix");
  }

  if (!canDetectMocking) {
    anomalies.push("mock_detection_unavailable");
  }

  return anomalies;
}

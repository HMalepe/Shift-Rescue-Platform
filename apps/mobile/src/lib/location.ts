import * as Location from "expo-location";
import { Platform } from "react-native";
import {
  buildAttendanceSignals,
  type AttendanceSignals,
  type Platform as SignalPlatform,
} from "./attendance";

/**
 * The thin bridge between `expo-location` and the pure signal logic.
 *
 * Kept thin on purpose: everything in `attendance.ts` is testable without a
 * device, and everything that genuinely needs a device is here. §16 is clear
 * that the device half cannot be verified by an emulator, so the goal is to
 * make that unverifiable surface as small as it can be.
 */

export type CaptureResult =
  | { readonly kind: "captured"; readonly signals: AttendanceSignals }
  | { readonly kind: "denied" }
  | { readonly kind: "services_off" }
  | { readonly kind: "failed"; readonly reason: string };

export async function captureAttendance(): Promise<CaptureResult> {
  /*
   * Foreground permission only. This app never needs a position when it is not
   * open — check-in is something a person does deliberately at a door — and
   * asking for background location would be asking to track a pharmacist's
   * movements all day for no product reason. Both app stores would rightly ask
   * why, and there is no good answer.
   */
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return { kind: "denied" };

  if (!(await Location.hasServicesEnabledAsync())) {
    return { kind: "services_off" };
  }

  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      /*
       * A fresh fix, always. `maximumAge` defaults to accepting a cached
       * position, and a cached fix from this morning is not evidence of being
       * at the pharmacy now — which is the entire claim a check-in makes.
       */
      mayShowUserSettingsDialog: true,
    });

    return {
      kind: "captured",
      signals: buildAttendanceSignals(
        {
          coords: {
            longitude: position.coords.longitude,
            latitude: position.coords.latitude,
            accuracy: position.coords.accuracy,
          },
          timestamp: position.timestamp,
          /*
           * §16's whole reason for choosing Expo. Android populates
           * `mocked`; iOS leaves it undefined, and `buildAttendanceSignals`
           * turns that absence into an honest "could not check" rather than a
           * reassuring `false`.
           */
          ...(typeof (position as { mocked?: boolean }).mocked === "boolean" && {
            mocked: (position as { mocked?: boolean }).mocked,
          }),
        },
        platformName(),
      ),
    };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "location unavailable",
    };
  }
}

function platformName(): SignalPlatform {
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "ios") return "ios";
  return "unknown";
}

/** Plain-language explanation for each non-captured outcome. */
export function explainCaptureFailure(result: CaptureResult): string | null {
  switch (result.kind) {
    case "captured":
      return null;
    case "denied":
      /*
       * §8 makes check-in opt-in. Refusing location is a valid choice, not an
       * error — the shift still happens, it simply has no attendance record,
       * and saying so beats nagging.
       */
      return "Location was not shared, so this shift will have no attendance record. That is allowed — the pharmacy will simply have nothing confirming your arrival.";
    case "services_off":
      return "Location services are switched off on this device. Turn them on to check in.";
    case "failed":
      return `Could not get a location fix: ${result.reason}`;
  }
}

"use client";

import { useRef, useState } from "react";

/**
 * The only client component in this app, and it is here for one reason:
 * `navigator.geolocation` exists only in a browser.
 *
 * §8's whole point is that attendance is evidence. What is sent is a *claimed*
 * coordinate and the accuracy radius the device reported; the distance from
 * the pharmacy is computed server-side against the pharmacy's stored location.
 * A distance calculated here would be a number this device chose, which is
 * worth nothing in a dispute.
 *
 * `mockLocationDetected` is deliberately never sent from the web. §16 requires
 * Android's `isFromMockProvider()`, which has no browser equivalent — and the
 * API distinguishes *absent* from *false*. Sending `false` from here would
 * assert "this device checked for spoofing and found none", which is a lie
 * that lands in an attendance record someone may later rely on.
 */
export function CheckInForm({
  action,
  bookingId,
  label,
}: {
  action: (formData: FormData) => void;
  bookingId: string;
  label: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<"idle" | "locating" | "denied" | "unavailable">(
    "idle",
  );

  function submitWithLocation() {
    if (!("geolocation" in navigator)) {
      setState("unavailable");
      return;
    }

    setState("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const form = formRef.current;
        if (!form) return;
        (form.elements.namedItem("lng") as HTMLInputElement).value = String(
          position.coords.longitude,
        );
        (form.elements.namedItem("lat") as HTMLInputElement).value = String(
          position.coords.latitude,
        );
        (form.elements.namedItem("accuracyM") as HTMLInputElement).value = String(
          Math.round(position.coords.accuracy),
        );
        form.requestSubmit();
      },
      () => setState("denied"),
      {
        // A cached fix from this morning is not evidence of being at the
        // pharmacy now, so a stale position is refused outright.
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15_000,
      },
    );
  }

  return (
    <form ref={formRef} action={action}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="lng" />
      <input type="hidden" name="lat" />
      <input type="hidden" name="accuracyM" />

      <button
        type="button"
        className="primary"
        onClick={submitWithLocation}
        disabled={state === "locating"}
      >
        {state === "locating" ? "Getting your location…" : label}
      </button>

      {state === "denied" ? (
        <p className="hint" style={{ color: "var(--danger)" }}>
          {/*
            §8 makes check-in opt-in. Refusing location is a valid choice, not
            an error — the shift still happens, it simply has no attendance
            record, and the honest thing is to say so rather than nag.
          */}
          Location was not shared, so this shift will have no attendance record. That is
          allowed; the pharmacy will simply have nothing to confirm your arrival.
        </p>
      ) : null}
      {state === "unavailable" ? (
        <p className="hint">This browser cannot share a location.</p>
      ) : null}
    </form>
  );
}

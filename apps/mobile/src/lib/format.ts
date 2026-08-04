/**
 * Locale-pinned to South Africa, for the same reason as the web client: a
 * device set to en-US renders "8/3, 2:00 PM" for a shift on the 3rd of August,
 * and for a product whose job is telling a pharmacist when to arrive that is
 * not cosmetic.
 *
 * Unlike the web this runs on the user's own device, so the locale could be
 * anything at all — which makes pinning it more important here, not less.
 */
const TZ = "Africa/Johannesburg";

export function formatTimeRange(start: string, end: string): string {
  const from = new Date(start);
  const to = new Date(end);
  const day = from.toLocaleDateString("en-ZA", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = (d: Date) =>
    d.toLocaleTimeString("en-ZA", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return `${day}, ${time(from)}–${time(to)}`;
}

/** Cents in, rands out — never through a float. */
export function formatRands(cents: number): string {
  const whole = Math.trunc(Math.abs(cents) / 100).toLocaleString("en-ZA");
  const fraction = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}R${whole}.${fraction}`;
}

export function formatDistance(metres: number | null | undefined): string {
  if (metres == null) return "—";
  return metres < 950 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`;
}

export function bookingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    requested: "Applied",
    confirmed: "Confirmed",
    cancelled_by_locum: "You cancelled",
    cancelled_by_manager: "Pharmacy cancelled",
    completed: "Completed",
    disputed: "Disputed",
    no_show: "No show",
  };
  return labels[status] ?? status;
}

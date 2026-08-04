/**
 * Presentation helpers.
 *
 * All of these are locale-pinned to South Africa on purpose. `toLocaleString`
 * with no locale renders in whatever locale the *server* happens to run in,
 * which in a container is usually `en-US` — so a shift at 14:00 on the 3rd of
 * August would render as "8/3, 2:00 PM" to a user who reads dates the other
 * way round. For a product whose whole job is telling a pharmacist when to
 * arrive, that is not a cosmetic bug.
 */

const TZ = "Africa/Johannesburg";

export function formatDateTime(value: Date | string): string {
  return new Date(value).toLocaleString("en-ZA", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatTimeRange(start: Date | string, end: Date | string): string {
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

/**
 * Rands from cents.
 *
 * Cents in, formatted out — the value never becomes a float on the way. Money
 * is stored as integer cents throughout this codebase for exactly this reason,
 * and dividing by 100 into a `Number` here would reintroduce the rounding the
 * schema went to the trouble of avoiding.
 */
export function formatRands(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toLocaleString("en-ZA");
  const fraction = String(abs % 100).padStart(2, "0");
  return `${sign}R${whole}.${fraction}`;
}

export function formatDistance(metres: number | null | undefined): string {
  if (metres === null || metres === undefined) return "—";
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Human label for a booking status. */
export function bookingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    requested: "Applied",
    confirmed: "Confirmed",
    cancelled_by_locum: "Cancelled by locum",
    cancelled_by_manager: "Cancelled by pharmacy",
    completed: "Completed",
    disputed: "Disputed",
    no_show: "No show",
  };
  return labels[status] ?? status;
}

export function badgeToneFor(status: string): string {
  if (status === "confirmed" || status === "completed" || status === "verified") {
    return "badge badge-ok";
  }
  if (status === "requested" || status === "pending" || status === "open") {
    return "badge badge-warn";
  }
  if (status.startsWith("cancelled") || status === "no_show" || status === "rejected") {
    return "badge badge-danger";
  }
  return "badge";
}

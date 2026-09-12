import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import {
  badgeToneFor,
  bookingStatusLabel,
  formatRands,
  formatTimeRange,
} from "@/lib/format";

interface MyBooking {
  bookingId: string;
  status: string;
  shiftId: string;
  startsAt: string;
  endsAt: string;
  hourlyRateCents: number;
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const viewer = await requireRole("locum");
  const [bookings, { error, notice }] = await Promise.all([
    api.query<MyBooking[]>("bookings.mine"),
    searchParams,
  ]);

  async function cancel(formData: FormData) {
    "use server";
    const bookingId = String(formData.get("bookingId") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();

    try {
      await api.mutate("bookings.cancel", {
        bookingId,
        ...(reason !== "" && { reason }),
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not cancel the booking";
      redirect(`/bookings?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/bookings");
    redirect(
      `/bookings?notice=${encodeURIComponent(
        "Cancelled. The pharmacy has been notified.",
      )}`,
    );
  }

  const now = Date.now();

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <h1>My bookings</h1>
        <p className="lede">
          {bookings.length === 0
            ? "Shifts you have applied for or confirmed."
            : `${bookings.length} shift${bookings.length === 1 ? "" : "s"} applied for or confirmed.`}
        </p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="alert alert-note" role="status">
            {notice}
          </p>
        ) : null}

        {bookings.length === 0 ? (
          <p className="empty">
            No bookings yet. <Link href="/browse">Find a shift</Link>.
          </p>
        ) : (
          <div className="stack">
            {bookings.map((booking) => {
              const startsAt = new Date(booking.startsAt).getTime();
              const isUpcoming = startsAt > now;
              /*
               * §9 — under 24 hours' notice puts a R10 accountability charge on
               * the pharmacy's next invoice, which is the pharmacy's cost, not
               * the locum's. It is surfaced here anyway: someone cancelling
               * late should know it has a consequence for the person who was
               * relying on them, and finding that out afterwards feels like a
               * trap.
               */
              const isShortNotice = isUpcoming && startsAt - now < 24 * 3_600_000;

              return (
                <article key={booking.bookingId} className="card">
                  <div className="spread">
                    <div>
                      <div className="row">
                        <strong>{formatTimeRange(booking.startsAt, booking.endsAt)}</strong>
                        <span className={badgeToneFor(booking.status)}>
                          {bookingStatusLabel(booking.status)}
                        </span>
                      </div>
                      <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                        {formatRands(booking.hourlyRateCents)}/hour
                      </p>
                    </div>

                    <div className="row" style={{ gap: "0.5rem" }}>
                      {booking.status === "confirmed" || booking.status === "requested" ? (
                        <Link href={`/bookings/${booking.bookingId}`} className="button">
                          Open
                        </Link>
                      ) : null}
                    </div>
                  </div>

                  {(booking.status === "confirmed" || booking.status === "requested") &&
                  isUpcoming ? (
                    <details style={{ marginTop: "0.9rem" }}>
                      <summary className="dim" style={{ cursor: "pointer", fontSize: "0.9rem" }}>
                        Cancel this booking
                      </summary>
                      <form action={cancel} style={{ marginTop: "0.7rem" }}>
                        <input type="hidden" name="bookingId" value={booking.bookingId} />
                        {isShortNotice ? (
                          <p className="alert alert-error" role="note">
                            Under 24 hours&rsquo; notice. The pharmacy may struggle to
                            find cover — please tell them why.
                          </p>
                        ) : null}
                        <div className="field">
                          <label htmlFor={`reason-${booking.bookingId}`}>Reason</label>
                          <input
                            id={`reason-${booking.bookingId}`}
                            name="reason"
                            maxLength={500}
                            placeholder="Illness, emergency, double-booked…"
                          />
                        </div>
                        <button type="submit">Cancel booking</button>
                      </form>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}

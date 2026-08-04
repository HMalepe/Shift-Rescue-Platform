import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireViewer } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { CheckInForm } from "@/components/CheckInForm";
import { formatDateTime, formatDistance } from "@/lib/format";

interface ThreadMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
}

interface Attendance {
  checkedInAt: string | null;
  checkedOutAt: string | null;
  checkInDistanceM: number | null;
  checkOutDistanceM: number | null;
}

/**
 * One booking: the conversation, and (for the locum) attendance.
 *
 * Both sides of a booking land on this page — §6 messaging has exactly two
 * participants and the API decides which one you are. Nothing here branches on
 * role for *authorization*; the role only decides which controls are worth
 * rendering.
 */
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const viewer = await requireViewer();
  const { bookingId } = await params;
  const { error } = await searchParams;

  const messages = await api.query<ThreadMessage[]>("messages.thread", { bookingId });

  /*
   * The rating prompt appears only for a shift this person worked and has not
   * yet rated. Asked once: a system that nags produces ratings given to make
   * the nagging stop, which is worse than no ratings at all.
   */
  const pending = await api
    .query<Array<{ bookingId: string }>>("reputation.pending")
    .catch(() => []);
  const pendingRating = pending.some((row) => row.bookingId === bookingId);

  /*
   * Attendance is a locum-only procedure, and a manager opening this page must
   * not see a 403 for a panel they never asked for. Managers get the timesheet
   * from the shift instead.
   */
  const attendance =
    viewer.role === "locum"
      ? await api
          .query<Attendance | null>("attendance.mine", { bookingId })
          .catch(() => null)
      : null;

  async function send(formData: FormData) {
    "use server";
    const body = String(formData.get("body") ?? "").trim();
    if (body === "") return;

    try {
      await api.mutate("messages.post", { bookingId, body });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not send the message";
      redirect(`/bookings/${bookingId}?error=${encodeURIComponent(message)}`);
    }

    revalidatePath(`/bookings/${bookingId}`);
  }

  async function rate(formData: FormData) {
    "use server";
    const score = Number(formData.get("score"));
    const comment = String(formData.get("comment") ?? "").trim();

    try {
      await api.mutate("reputation.rate", {
        bookingId,
        score,
        ...(comment !== "" && { comment }),
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not save your rating";
      redirect(`/bookings/${bookingId}?error=${encodeURIComponent(message)}`);
    }

    revalidatePath(`/bookings/${bookingId}`);
  }

  async function checkIn(formData: FormData) {
    "use server";
    await recordAttendance("attendance.checkIn", bookingId, formData);
  }

  async function checkOut(formData: FormData) {
    "use server";
    await recordAttendance("attendance.checkOut", bookingId, formData);
  }

  const backHref = viewer.role === "locum" ? "/bookings" : "/shifts";

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "48rem" }}>
        <p className="dim" style={{ marginBottom: "0.5rem" }}>
          <Link href={backHref}>← Back</Link>
        </p>
        <h1>Messages</h1>
        <p className="lede">
          {/*
            §10.1, stated to the user rather than only implemented. "A manager
            should never need to give out, or receive, a personal number to
            complete a booking" — saying so is what makes people stop asking.
          */}
          Everything here stays on the platform. Neither side needs to share a personal
          number.
        </p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        {attendance ? (
          <section className="card" style={{ marginBottom: "1.5rem" }}>
            <h2 style={{ margin: "0 0 0.75rem" }}>Attendance</h2>
            {attendance.checkedInAt ? (
              <p className="dim" style={{ margin: "0 0 0.75rem" }}>
                Checked in {formatDateTime(attendance.checkedInAt)}
                {attendance.checkInDistanceM !== null
                  ? ` · ${formatDistance(attendance.checkInDistanceM)} from the pharmacy`
                  : ""}
                {attendance.checkedOutAt ? (
                  <>
                    <br />
                    Checked out {formatDateTime(attendance.checkedOutAt)}
                  </>
                ) : null}
              </p>
            ) : (
              <p className="dim" style={{ margin: "0 0 0.75rem" }}>
                Not checked in yet.
              </p>
            )}

            {!attendance.checkedInAt ? (
              <CheckInForm action={checkIn} bookingId={bookingId} label="Check in" />
            ) : !attendance.checkedOutAt ? (
              <CheckInForm action={checkOut} bookingId={bookingId} label="Check out" />
            ) : null}
          </section>
        ) : viewer.role === "locum" ? (
          <section className="card" style={{ marginBottom: "1.5rem" }}>
            <h2 style={{ margin: "0 0 0.5rem" }}>Attendance</h2>
            <p className="dim" style={{ margin: "0 0 0.75rem" }}>
              Not checked in yet.
            </p>
            <CheckInForm action={checkIn} bookingId={bookingId} label="Check in" />
          </section>
        ) : null}

        {pendingRating ? (
          <section className="card" style={{ marginBottom: "1.5rem" }}>
            <h2 style={{ margin: "0 0 0.5rem" }}>How did this shift go?</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              {/*
                §7 — asked once, plainly, and only after the shift. The other
                side rates you on the same scale. Ratings are shown as a coarse
                band and only once enough people have rated, so nobody can work
                out what you said.
              */}
              Shown to others as a band, never as a number, and only once enough
              people have rated to keep yours anonymous.
            </p>
            <form action={rate}>
              <div className="field">
                <label htmlFor="score">Rating</label>
                <select id="score" name="score" defaultValue="5" required>
                  <option value="5">5 — excellent</option>
                  <option value="4">4 — good</option>
                  <option value="3">3 — acceptable</option>
                  <option value="2">2 — poor</option>
                  <option value="1">1 — unacceptable</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="comment">Anything worth noting? (optional)</label>
                <textarea id="comment" name="comment" maxLength={1000} />
              </div>
              <button type="submit" className="primary">
                Submit rating
              </button>
            </form>
          </section>
        ) : null}

        <div className="thread">
          {messages.length === 0 ? (
            <p className="empty">No messages yet.</p>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.senderId === viewer.id ? "msg msg-mine" : "msg"
                }
              >
                <div className="msg-meta">
                  {message.senderId === viewer.id ? "You" : "Them"} ·{" "}
                  {formatDateTime(message.createdAt)}
                </div>
                {message.body}
              </div>
            ))
          )}
        </div>

        <form action={send} className="card">
          <div className="field">
            <label htmlFor="body">Message</label>
            <textarea id="body" name="body" maxLength={2000} required />
          </div>
          <button type="submit" className="primary">
            Send
          </button>
        </form>
      </main>
    </>
  );
}

/**
 * Shared by check-in and check-out.
 *
 * A missing coordinate is treated as "the user declined", not as an error to
 * report. §8 makes attendance opt-in, and the CheckInForm has already
 * explained the consequence — throwing here would turn a valid choice into a
 * red banner.
 */
async function recordAttendance(
  procedure: string,
  bookingId: string,
  formData: FormData,
): Promise<void> {
  const lng = Number(formData.get("lng"));
  const lat = Number(formData.get("lat"));
  const accuracyM = Number(formData.get("accuracyM"));

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

  try {
    await api.mutate(procedure, {
      bookingId,
      location: { lng, lat },
      ...(Number.isFinite(accuracyM) ? { accuracyM: Math.round(accuracyM) } : {}),
    });
  } catch (caught) {
    const message =
      caught instanceof ApiError ? caught.message : "Could not record attendance";
    redirect(`/bookings/${bookingId}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/bookings/${bookingId}`);
}

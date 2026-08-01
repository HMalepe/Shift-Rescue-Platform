import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { badgeToneFor, bookingStatusLabel, formatDateTime } from "@/lib/format";
import { ReputationBadge, type Reputation } from "@/components/ReputationBadge";

interface Applicant {
  bookingId: string;
  status: string;
  requestedAt: string;
  locumId: string;
  fullName: string;
  verification: string;
  reliabilityScore: number | null;
  completedShifts: number;
  noShows: number;
}

/**
 * The applicants for one shift, and the confirm action.
 *
 * This page is where the §12.2 race actually happens: two managers at the same
 * pharmacy, both looking at this list, both clicking Confirm. The API settles
 * it with a row lock and a partial unique index, and the loser gets
 * `SHIFT_ALREADY_FILLED`. All this page has to do is render that as an
 * explanation rather than an error — the shift is covered, which is what they
 * wanted.
 */
export default async function ShiftApplicantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ shiftId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const viewer = await requireRole("manager");
  const { shiftId } = await params;
  const [applicants, { error, notice }] = await Promise.all([
    api.query<Applicant[]>("bookings.listApplicants", { shiftId }),
    searchParams,
  ]);

  /*
   * §7 tiers, fetched per applicant. A shift has a handful of applicants, so
   * the fan-out is bounded and parallel — but it IS an N+1, and it is the
   * right trade only because N is small by construction. If applicant lists
   * ever grow, this belongs in the listApplicants projection.
   */
  const reputations = new Map(
    await Promise.all(
      applicants.map(
        async (applicant) =>
          [
            applicant.locumId,
            await api.query<Reputation>("reputation.of", { userId: applicant.locumId }),
          ] as const,
      ),
    ),
  );

  async function confirm(formData: FormData) {
    "use server";
    const bookingId = String(formData.get("bookingId") ?? "");

    try {
      await api.mutate("bookings.confirm", { bookingId });
    } catch (caught) {
      if (caught instanceof ApiError && caught.domainCode === "SHIFT_ALREADY_FILLED") {
        // Not an error worth alarming anyone about: someone else confirmed
        // first, and the shift has cover. That is the outcome the pharmacy
        // wanted, arrived at by a colleague.
        redirect(
          `/shifts/${shiftId}?notice=${encodeURIComponent(
            "Someone else confirmed a locum for this shift first. It is covered.",
          )}`,
        );
      }
      const message =
        caught instanceof ApiError ? caught.message : "Could not confirm the booking";
      redirect(`/shifts/${shiftId}?error=${encodeURIComponent(message)}`);
    }

    revalidatePath(`/shifts/${shiftId}`);
    revalidatePath("/shifts");
  }

  const confirmed = applicants.find((a) => a.status === "confirmed");

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <p className="dim" style={{ marginBottom: "0.5rem" }}>
          <Link href="/shifts">← All shifts</Link>
        </p>
        <h1>Applicants</h1>
        <p className="lede">
          {confirmed
            ? "This shift is covered."
            : "Confirm one locum. The others are notified automatically."}
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

        {applicants.length === 0 ? (
          <p className="empty">
            Nobody has applied yet. If this is urgent, consider widening the shift&rsquo;s
            reach beyond your saved locums.
          </p>
        ) : (
          <div className="scroll-x card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Locum</th>
                  <th>Track record</th>
                  <th>Applied</th>
                  <th>Status</th>
                  <th><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {applicants.map((applicant) => (
                  <tr key={applicant.bookingId}>
                    <td>
                      <strong>{applicant.fullName}</strong>
                      <div className="row" style={{ gap: "0.35rem" }}>
                        <span className={badgeToneFor(applicant.verification)}>
                          {applicant.verification}
                        </span>
                        {reputations.get(applicant.locumId) ? (
                          <ReputationBadge
                            reputation={reputations.get(applicant.locumId)!}
                          />
                        ) : null}
                      </div>
                    </td>
                    <td className="dim">
                      {applicant.completedShifts} completed
                      {applicant.noShows > 0 ? (
                        <>
                          {" · "}
                          <span style={{ color: "var(--danger)" }}>
                            {applicant.noShows} no-show
                            {applicant.noShows === 1 ? "" : "s"}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="dim">{formatDateTime(applicant.requestedAt)}</td>
                    <td>
                      <span className={badgeToneFor(applicant.status)}>
                        {bookingStatusLabel(applicant.status)}
                      </span>
                    </td>
                    <td>
                      {applicant.status === "requested" &&
                      !confirmed &&
                      applicant.verification === "verified" ? (
                        <form action={confirm}>
                          <input
                            type="hidden"
                            name="bookingId"
                            value={applicant.bookingId}
                          />
                          <button type="submit" className="primary">
                            Confirm
                          </button>
                        </form>
                      ) : applicant.status === "requested" && !confirmed ? (
                        /*
                         * §5 — an unverified applicant gets no Confirm button.
                         * The board previously offered one next to an
                         * applicant marked REJECTED; the API refuses it, so
                         * the button was an invitation to an error message.
                         * Saying why is more useful than hiding the row: the
                         * manager can see there is an applicant and that
                         * somebody still has to check them.
                         */
                        <span className="hint">
                          Cannot confirm until verified
                        </span>
                      ) : applicant.status === "confirmed" ? (
                        <Link href={`/bookings/${applicant.bookingId}`} className="button">
                          Message
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { badgeToneFor, formatDateTime } from "@/lib/format";

interface PendingDocument {
  documentId: string;
  userId: string;
  fullName: string;
  type: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedAt: string;
  currentStatus: string | null;
  sapcNumber: string | null;
}

interface PendingLocum {
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  sapcNumber: string | null;
  verification: string;
  maxTravelKm: number;
}

interface PendingPharmacy {
  pharmacyId: string;
  name: string;
  tradingName: string | null;
  city: string;
  suburb: string | null;
  sapcPharmacyNumber: string | null;
  verification: string;
  createdAt: string;
}

/**
 * §5/§12.1 — the document review queue.
 *
 * This queue is the platform's core promise to a manager: that somebody
 * actually checked the registration. The two decisions worth explaining:
 *
 * The document itself is not linked inline. `verification.documentUrl` is a
 * *mutation* that mints a short-lived, reviewer-bound URL, and minting one per
 * row would scatter live links to ID documents through server logs and browser
 * history. A reviewer asks for one when they open a specific document.
 *
 * Rejection requires a reason. The API allows it to be omitted; this form does
 * not, because "rejected" with no reason reaches a real pharmacist as an
 * unexplained refusal to let them work, and they have no way to fix it.
 */
export default async function VerificationQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; url?: string }>;
}) {
  const viewer = await requireRole("admin");
  const [pending, pendingLocums, pendingPharmacies, { error, url }] = await Promise.all([
    api.query<PendingDocument[]>("verification.queue", { limit: 50 }),
    api.query<PendingLocum[]>("verification.queueLocums", { limit: 50 }),
    api.query<PendingPharmacy[]>("verification.queuePharmacies", { limit: 50 }),
    searchParams,
  ]);

  async function openDocument(formData: FormData) {
    "use server";
    const documentId = String(formData.get("documentId") ?? "");
    try {
      const signed = await api.mutate<{ url: string } | string>(
        "verification.documentUrl",
        { documentId },
      );
      const href = typeof signed === "string" ? signed : signed.url;
      redirect(`/admin/verification?url=${encodeURIComponent(href)}`);
    } catch (caught) {
      if (caught instanceof ApiError) {
        redirect(`/admin/verification?error=${encodeURIComponent(caught.message)}`);
      }
      throw caught;
    }
  }

  async function review(formData: FormData) {
    "use server";
    const documentId = String(formData.get("documentId") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();

    if (decision === "rejected" && reason === "") {
      redirect(
        `/admin/verification?error=${encodeURIComponent(
          "A rejection needs a reason — the locum has to know what to fix.",
        )}`,
      );
    }

    try {
      await api.mutate("verification.review", {
        documentId,
        decision,
        ...(reason !== "" && { reason }),
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not record the decision";
      redirect(`/admin/verification?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/admin/verification");
  }

  async function reviewLocum(formData: FormData) {
    "use server";
    const userId = String(formData.get("userId") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();

    if (decision === "rejected" && reason === "") {
      redirect(
        `/admin/verification?error=${encodeURIComponent(
          "A rejection needs a reason — the locum has to know what to fix.",
        )}`,
      );
    }

    try {
      await api.mutate("verification.reviewLocum", {
        userId,
        decision,
        ...(reason !== "" && { reason }),
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not record the decision";
      redirect(`/admin/verification?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/admin/verification");
  }

  async function reviewPharmacy(formData: FormData) {
    "use server";
    const pharmacyId = String(formData.get("pharmacyId") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();

    if (decision === "rejected" && reason === "") {
      redirect(
        `/admin/verification?error=${encodeURIComponent(
          "A rejection needs a reason — the manager has to know what to fix.",
        )}`,
      );
    }

    try {
      await api.mutate("verification.reviewPharmacy", {
        pharmacyId,
        decision,
        ...(reason !== "" && { reason }),
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : "Could not record the decision";
      redirect(`/admin/verification?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/admin/verification");
  }

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <h1>Verification queue</h1>

        <h2>Locums</h2>
        <p className="lede" style={{ marginBottom: "1rem" }}>
          {pendingLocums.length === 0
            ? "No locums waiting for an SAPC check."
            : `${pendingLocums.length} locum${pendingLocums.length === 1 ? "" : "s"} waiting for an SAPC check.`}{" "}
          Checked against the registration number on their profile.
        </p>
        {pendingLocums.length === 0 ? (
          <p className="empty">Nothing waiting for review.</p>
        ) : (
          <div className="stack">
            {pendingLocums.map((locum) => (
              <article key={locum.userId} className="card">
                <div className="row">
                  <strong>{locum.fullName}</strong>
                  <span className={badgeToneFor(locum.verification)}>{locum.verification}</span>
                </div>
                <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                  {locum.email}
                  {locum.phone ? ` · ${locum.phone}` : ""}
                </p>
                <p style={{ margin: "0.4rem 0 0" }}>
                  SAPC registration number:{" "}
                  <strong className="mono">{locum.sapcNumber ?? "—"}</strong>
                </p>
                <form action={reviewLocum} style={{ marginTop: "1rem" }}>
                  <input type="hidden" name="userId" value={locum.userId} />
                  <div className="field">
                    <label htmlFor={`locum-reason-${locum.userId}`}>
                      Reason (required to reject)
                    </label>
                    <input
                      id={`locum-reason-${locum.userId}`}
                      name="reason"
                      maxLength={500}
                      placeholder="Name does not match the SAPC register…"
                    />
                  </div>
                  <div className="row" style={{ gap: "0.5rem" }}>
                    <button type="submit" name="decision" value="verified" className="primary">
                      Verify
                    </button>
                    <button type="submit" name="decision" value="rejected">
                      Reject
                    </button>
                  </div>
                </form>
              </article>
            ))}
          </div>
        )}

        <h2 style={{ marginTop: "2.5rem" }}>Documents</h2>
        <p className="lede">
          {pending.length === 0
            ? "Documents that passed their security scan and are waiting on a human."
            : `${pending.length} document${pending.length === 1 ? "" : "s"} waiting on a human.`}
        </p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        {url ? (
          <p className="alert alert-note" role="status">
            Signed link ready —{" "}
            <a href={url} target="_blank" rel="noreferrer">
              open document
            </a>
            . It expires shortly and is bound to your account.
          </p>
        ) : null}

        {pending.length === 0 ? (
          <p className="empty">Nothing waiting for review.</p>
        ) : (
          <div className="stack">
            {pending.map((doc) => (
              <article key={doc.documentId} className="card">
                <div className="spread">
                  <div>
                    <div className="row">
                      <strong>{doc.fullName}</strong>
                      <span className={badgeToneFor(doc.currentStatus ?? "pending")}>
                        {doc.currentStatus ?? "pending"}
                      </span>
                    </div>
                    <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                      {doc.type}
                      {doc.sapcNumber ? ` · SAPC ${doc.sapcNumber}` : ""} ·{" "}
                      {Math.round(doc.sizeBytes / 1024)} kB
                      {doc.mimeType ? ` · ${doc.mimeType}` : ""}
                    </p>
                    <p className="hint">Uploaded {formatDateTime(doc.uploadedAt)}</p>
                  </div>

                  <form action={openDocument}>
                    <input type="hidden" name="documentId" value={doc.documentId} />
                    <button type="submit">View document</button>
                  </form>
                </div>

                <form action={review} style={{ marginTop: "1rem" }}>
                  <input type="hidden" name="documentId" value={doc.documentId} />
                  <div className="field">
                    <label htmlFor={`reason-${doc.documentId}`}>
                      Reason (required to reject)
                    </label>
                    <input
                      id={`reason-${doc.documentId}`}
                      name="reason"
                      maxLength={500}
                      placeholder="Name does not match the SAPC register…"
                    />
                  </div>
                  <div className="row" style={{ gap: "0.5rem" }}>
                    <button
                      type="submit"
                      name="decision"
                      value="verified"
                      className="primary"
                    >
                      Verify
                    </button>
                    <button type="submit" name="decision" value="rejected">
                      Reject
                    </button>
                  </div>
                </form>
              </article>
            ))}
          </div>
        )}

        <h2 style={{ marginTop: "2.5rem" }}>Pharmacies</h2>
        <p className="lede" style={{ marginBottom: "1rem" }}>
          {pendingPharmacies.length === 0
            ? "No pharmacy SAPC numbers waiting on a check."
            : `${pendingPharmacies.length} pharmacy SAPC number${
                pendingPharmacies.length === 1 ? "" : "s"
              } waiting on a check.`}{" "}
          Checked directly against the SAPC register — no document upload for this one.
        </p>

        {pendingPharmacies.length === 0 ? (
          <p className="empty">Nothing waiting for review.</p>
        ) : (
          <div className="stack">
            {pendingPharmacies.map((pharmacy) => (
              <article key={pharmacy.pharmacyId} className="card">
                <div className="row">
                  <strong>{pharmacy.tradingName ?? pharmacy.name}</strong>
                  <span className={badgeToneFor(pharmacy.verification)}>
                    {pharmacy.verification}
                  </span>
                </div>
                <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                  {pharmacy.suburb ? `${pharmacy.suburb}, ` : ""}
                  {pharmacy.city}
                </p>
                <p style={{ margin: "0.4rem 0 0" }}>
                  SAPC pharmacy number:{" "}
                  <strong className="mono">{pharmacy.sapcPharmacyNumber ?? "—"}</strong>
                </p>

                <form action={reviewPharmacy} style={{ marginTop: "1rem" }}>
                  <input type="hidden" name="pharmacyId" value={pharmacy.pharmacyId} />
                  <div className="field">
                    <label htmlFor={`pharmacy-reason-${pharmacy.pharmacyId}`}>
                      Reason (required to reject)
                    </label>
                    <input
                      id={`pharmacy-reason-${pharmacy.pharmacyId}`}
                      name="reason"
                      maxLength={500}
                      placeholder="Number does not match the SAPC register…"
                    />
                  </div>
                  <div className="row" style={{ gap: "0.5rem" }}>
                    <button
                      type="submit"
                      name="decision"
                      value="verified"
                      className="primary"
                    >
                      Verify
                    </button>
                    <button type="submit" name="decision" value="rejected">
                      Reject
                    </button>
                  </div>
                </form>
              </article>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

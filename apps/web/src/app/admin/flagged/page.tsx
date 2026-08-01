import { api } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { formatDateTime } from "@/lib/format";

interface FlaggedMessage {
  id: string;
  bookingId: string | null;
  senderId: string;
  body: string;
  flagReason: string | null;
  createdAt: string;
}

/**
 * §6/§14 — the disintermediation review queue.
 *
 * Every message here was **delivered**. Nothing was blocked, held or redacted,
 * and the page says so out loud, because a reviewer who believes these were
 * intercepted will treat the queue as an enforcement backlog and start acting
 * on it. It is not that. §14: the false-positive rate is unknown until a human
 * labels the corpus, and this is where those labels come from.
 *
 * The rule name that fired is shown next to the body. A reviewer needs to be
 * able to disagree with the detector, and "sa_mobile_number" is something you
 * can argue with in a way a confidence score is not.
 */
export default async function FlaggedMessagesPage() {
  const viewer = await requireRole("admin");
  const flagged = await api.query<FlaggedMessage[]>("messages.flagged", { limit: 100 });

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <h1>Flagged messages</h1>
        <p className="lede">
          Messages whose wording matched a disintermediation rule. All of them were
          delivered normally — this is a review queue, not a block list.
        </p>

        <p className="alert alert-note">
          The detector has never been measured against human labels. Treat a flag as
          &ldquo;worth a look&rdquo;, not as evidence of anything.
        </p>

        {flagged.length === 0 ? (
          <p className="empty">Nothing flagged.</p>
        ) : (
          <div className="stack">
            {flagged.map((message) => (
              <article key={message.id} className="card">
                <div className="row" style={{ marginBottom: "0.5rem" }}>
                  {(message.flagReason ?? "").split(",").filter(Boolean).map((rule) => (
                    <span key={rule} className="badge badge-warn">
                      {rule}
                    </span>
                  ))}
                  <span className="dim" style={{ fontSize: "0.85rem" }}>
                    {formatDateTime(message.createdAt)}
                  </span>
                </div>
                <p style={{ margin: 0 }}>{message.body}</p>
                <p className="hint mono" style={{ marginTop: "0.5rem" }}>
                  booking {message.bookingId ?? "—"}
                </p>
              </article>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

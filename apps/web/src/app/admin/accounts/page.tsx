import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";
import { requireRole } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";
import { badgeToneFor, formatDateTime } from "@/lib/format";

interface AccountPharmacy {
  pharmacyId: string;
  name: string;
  verification: string;
  sapcPharmacyNumber: string | null;
}

interface AccountRecord {
  id: string;
  email: string;
  fullName: string;
  role: string;
  phone: string | null;
  createdAt: string;
  locumVerification: string | null;
  sapcNumber: string | null;
  pharmacies: AccountPharmacy[];
}

function statusLabel(account: AccountRecord): { text: string; tone: string } {
  if (account.role === "admin") return { text: "admin", tone: badgeToneFor("admin") };
  if (account.role === "locum") {
    const status = account.locumVerification ?? "no profile";
    return { text: status, tone: badgeToneFor(status) };
  }
  if (account.pharmacies.length === 0) {
    return { text: "no pharmacy", tone: badgeToneFor("incomplete") };
  }
  const unverified = account.pharmacies.some((pharmacy) => pharmacy.verification !== "verified");
  const status = unverified ? "unverified pharmacy" : "verified";
  return { text: status, tone: badgeToneFor(unverified ? "incomplete" : "verified") };
}

/**
 * Every registered account. The verification queues only show people still
 * waiting on a decision, which reads as "nobody signed up" when the real
 * problem is a manager with no pharmacy, or a locum already verified.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const viewer = await requireRole("admin");
  const [accounts, { error }] = await Promise.all([
    api.query<AccountRecord[]>("verification.accounts"),
    searchParams,
  ]);

  async function reviewLocum(formData: FormData) {
    "use server";
    const userId = String(formData.get("userId") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (decision === "rejected" && reason === "") {
      redirect(
        `/admin/accounts?error=${encodeURIComponent(
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
      const message = caught instanceof ApiError ? caught.message : "Could not record the decision";
      redirect(`/admin/accounts?error=${encodeURIComponent(message)}`);
    }
    revalidatePath("/admin/accounts");
    revalidatePath("/admin/verification");
  }

  async function reviewPharmacy(formData: FormData) {
    "use server";
    const pharmacyId = String(formData.get("pharmacyId") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (decision === "rejected" && reason === "") {
      redirect(
        `/admin/accounts?error=${encodeURIComponent(
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
      const message = caught instanceof ApiError ? caught.message : "Could not record the decision";
      redirect(`/admin/accounts?error=${encodeURIComponent(message)}`);
    }
    revalidatePath("/admin/accounts");
    revalidatePath("/admin/verification");
  }

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell">
        <h1>Accounts</h1>
        <p className="lede">
          {accounts.length} registered account{accounts.length === 1 ? "" : "s"}. Verified and
          unverified are both listed here.
        </p>

        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        {accounts.length === 0 ? (
          <p className="empty">Nobody has registered yet.</p>
        ) : (
          <div className="stack">
            {accounts.map((account) => {
              const status = statusLabel(account);
              return (
                <article key={account.id} className="card">
                  <div className="spread">
                    <div>
                      <div className="row">
                        <strong>{account.fullName}</strong>
                        <span className={badgeToneFor(account.role)}>{account.role}</span>
                        <span className={status.tone}>{status.text}</span>
                      </div>
                      <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                        {account.email}
                        {account.phone ? ` · ${account.phone}` : ""}
                      </p>
                      <p className="hint">Registered {formatDateTime(account.createdAt)}</p>
                    </div>
                  </div>

                  {account.role === "locum" ? (
                    <p style={{ margin: "0.6rem 0 0" }}>
                      SAPC registration number:{" "}
                      <strong className="mono">{account.sapcNumber ?? "—"}</strong>
                    </p>
                  ) : null}

                  {account.role === "manager" && account.pharmacies.length === 0 ? (
                    <p className="dim" style={{ margin: "0.6rem 0 0" }}>
                      No pharmacy is linked, so this manager cannot post a shift until they add
                      one on their Profile page.
                    </p>
                  ) : null}

                  {account.pharmacies.map((pharmacy) => (
                    <div key={pharmacy.pharmacyId} style={{ marginTop: "0.8rem" }}>
                      <div className="row">
                        <strong>{pharmacy.name}</strong>
                        <span className={badgeToneFor(pharmacy.verification)}>
                          {pharmacy.verification}
                        </span>
                      </div>
                      <p className="dim" style={{ margin: "0.3rem 0 0" }}>
                        SAPC pharmacy number:{" "}
                        <strong className="mono">{pharmacy.sapcPharmacyNumber ?? "—"}</strong>
                      </p>
                      {pharmacy.verification !== "verified" ? (
                        <form action={reviewPharmacy} style={{ marginTop: "0.6rem" }}>
                          <input type="hidden" name="pharmacyId" value={pharmacy.pharmacyId} />
                          <div className="field">
                            <label htmlFor={`pharmacy-reason-${pharmacy.pharmacyId}`}>
                              Reason (required to reject)
                            </label>
                            <input
                              id={`pharmacy-reason-${pharmacy.pharmacyId}`}
                              name="reason"
                              maxLength={500}
                            />
                          </div>
                          <div className="row" style={{ gap: "0.5rem" }}>
                            <button
                              type="submit"
                              name="decision"
                              value="verified"
                              className="primary"
                            >
                              Verify pharmacy
                            </button>
                            <button type="submit" name="decision" value="rejected">
                              Reject
                            </button>
                          </div>
                        </form>
                      ) : null}
                    </div>
                  ))}

                  {account.role === "locum" &&
                  account.locumVerification &&
                  account.locumVerification !== "verified" ? (
                    <form action={reviewLocum} style={{ marginTop: "0.8rem" }}>
                      <input type="hidden" name="userId" value={account.id} />
                      <div className="field">
                        <label htmlFor={`locum-reason-${account.id}`}>
                          Reason (required to reject)
                        </label>
                        <input id={`locum-reason-${account.id}`} name="reason" maxLength={500} />
                      </div>
                      <div className="row" style={{ gap: "0.5rem" }}>
                        <button type="submit" name="decision" value="verified" className="primary">
                          Verify locum
                        </button>
                        <button type="submit" name="decision" value="rejected">
                          Reject
                        </button>
                      </div>
                    </form>
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

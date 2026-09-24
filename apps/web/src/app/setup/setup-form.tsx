"use client";

import Link from "next/link";
import { useActionState } from "react";
import { bootstrapAdmin, type SetupState } from "./actions";

export function SetupForm({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(bootstrapAdmin, null as SetupState);

  if (state?.ok) {
    return (
      <div className="card">
        <p>
          Admin account created for <strong>{state.email}</strong>. Add this to an
          authenticator app now — it is not shown again.
        </p>
        <div className="field">
          <label htmlFor="mfaSecret">Authenticator secret</label>
          <input id="mfaSecret" readOnly value={state.mfaSecret} />
        </div>
        <p className="hint">
          <a href={state.otpauthUrl}>Open in authenticator app</a>
        </p>
        <p className="hint" style={{ marginTop: "1rem" }}>
          Then <Link href="/login">sign in</Link> with that email, the Vercel
          password, and the 6-digit code.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="card">
      {state && !state.ok ? (
        <p className="alert alert-error" role="alert">
          {state.message}
        </p>
      ) : null}

      <p>
        This will create <strong>{email}</strong> from the Vercel env vars. The
        password never leaves the server.
      </p>

      <button type="submit" className="primary" style={{ width: "100%" }} disabled={pending}>
        {pending ? "Creating…" : "Create admin"}
      </button>
    </form>
  );
}

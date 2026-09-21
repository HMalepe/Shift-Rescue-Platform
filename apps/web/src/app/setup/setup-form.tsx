"use client";

import Link from "next/link";
import { useActionState } from "react";
import { bootstrapAdmin, type SetupState } from "./actions";

export function SetupForm() {
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
          Then <Link href="/login">sign in</Link> with email, password, and the 6-digit
          code.
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

      <div className="field">
        <label htmlFor="bootstrapSecret">Setup secret</label>
        <input
          id="bootstrapSecret"
          name="bootstrapSecret"
          type="password"
          required
          autoComplete="off"
        />
        <p className="hint">The ADMIN_SETUP_SECRET value from Railway.</p>
      </div>

      <div className="field">
        <label htmlFor="fullName">Full name</label>
        <input id="fullName" name="fullName" required minLength={2} maxLength={200} />
      </div>

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="username" />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
        />
        <p className="hint">At least 12 characters.</p>
      </div>

      <button type="submit" className="primary" style={{ width: "100%" }} disabled={pending}>
        {pending ? "Creating…" : "Create admin"}
      </button>
    </form>
  );
}

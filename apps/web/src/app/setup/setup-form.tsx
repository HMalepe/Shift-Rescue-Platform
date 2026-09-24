"use client";

import Link from "next/link";
import { useActionState } from "react";
import { applyAdminPassword, bootstrapAdmin, type SetupState } from "./actions";

export function PasswordForm({ email, mode }: { email: string; mode: "create" | "reset" }) {
  const action = mode === "create" ? bootstrapAdmin : applyAdminPassword;
  const [state, formAction, pending] = useActionState(action, null as SetupState);

  if (state?.ok) {
    return (
      <div className="card">
        <p>
          {mode === "create" ? "Admin account created" : "Password updated"} for{" "}
          <strong>{state.email}</strong>.
        </p>
        <p className="hint" style={{ marginTop: "1rem" }}>
          <Link href="/login">Sign in</Link> with that email and the Vercel password.
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
        {mode === "create"
          ? `This will create ${email} from the Vercel env vars.`
          : `This will set the password for ${email} from ADMIN_PASSWORD.`}{" "}
        The password never leaves the server.
      </p>

      <button type="submit" className="primary" style={{ width: "100%" }} disabled={pending}>
        {pending ? "Saving…" : mode === "create" ? "Create admin" : "Use Vercel password"}
      </button>
    </form>
  );
}

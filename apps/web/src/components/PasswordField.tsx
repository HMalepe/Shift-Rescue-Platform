"use client";

import { useId, useState } from "react";

/**
 * Password input with a control to show what was typed. The value stays in the
 * form under `name` so a server action can read it either way.
 */
export function PasswordField({
  id,
  name = "password",
  label = "Password",
  autoComplete,
}: {
  id?: string;
  name?: string;
  label?: string;
  autoComplete: "current-password" | "new-password";
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = useState(false);

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="password-field">
        <input
          id={inputId}
          name={name}
          type={visible ? "text" : "password"}
          required
          maxLength={200}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 3l18 18M10.5 10.7a3 3 0 0 0 4.2 4.2M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.4 18.4 0 0 1-4.1 4.8M6.1 6.2C3.6 7.8 2 12 2 12a18.6 18.6 0 0 0 6.2 6.6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

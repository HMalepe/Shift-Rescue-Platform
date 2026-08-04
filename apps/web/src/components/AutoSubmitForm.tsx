"use client";

import { useEffect, useRef } from "react";

/**
 * Payfast's Subscribe flow is a hosted checkout page, reached by a browser
 * POST carrying the signed fields — not a GET redirect, so `redirect()` in a
 * Server Action cannot get the user there directly. This renders the real
 * form and submits it itself the instant it mounts, which is the standard
 * shape for handing a browser off to a third-party payment page.
 */
export function AutoSubmitForm({
  url,
  fields,
}: {
  readonly url: string;
  readonly fields: ReadonlyArray<readonly [string, string]>;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.submit();
  }, []);

  return (
    <form ref={formRef} method="POST" action={url}>
      {fields.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <noscript>
        <button type="submit">Continue to Payfast</button>
      </noscript>
    </form>
  );
}

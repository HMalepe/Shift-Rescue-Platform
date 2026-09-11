"use client";

/**
 * Root error boundary.
 *
 * Every page in this app calls the API from a Server Component, and a network
 * failure there — the API down, a timeout, DNS hiccup — throws a plain
 * `TypeError` that is neither `ApiError` nor `UnauthenticatedError` (see
 * `lib/api.ts`). Without a boundary that surfaces as Next's default error
 * screen: a stack trace in development, a bare "something went wrong" outside
 * it. Neither tells a pharmacy manager what to do next, and this app deals in
 * shift cover — the moment they can't reach it is exactly the moment they most
 * need to know whether that's them or us.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="shell" style={{ maxWidth: "32rem", paddingTop: "5rem" }}>
      <h1>Something went wrong</h1>
      <p className="lede">
        We couldn&rsquo;t load this page. This is usually temporary — try again in a
        moment.
      </p>
      <button type="button" className="primary" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}

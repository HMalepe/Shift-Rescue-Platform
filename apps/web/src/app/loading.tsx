/**
 * Root loading state.
 *
 * Every page here is a Server Component that awaits the API before rendering
 * anything — `shifts.mine`, `bookings.mine`, the ops dashboard's five parallel
 * queries. With no `loading.tsx`, Next shows a blank tab until the slowest of
 * those resolves, which on a mobile connection reads as a hang rather than a
 * page that is coming.
 */
export default function Loading() {
  return (
    <main className="shell" style={{ paddingTop: "4rem" }}>
      <p className="dim">Loading…</p>
    </main>
  );
}

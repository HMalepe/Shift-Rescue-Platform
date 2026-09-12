/**
 * Phase 1 launches to locums paid directly by their own pharmacy/HR — the
 * platform charges nobody yet. Must match `apps/api`'s `BILLING_ENABLED`
 * (apps/api/src/config.ts) — that flag is what actually stops a manager
 * without a subscription from posting shifts; this one only decides whether
 * this app's own UI ever asks anyone for payment. Off by default, same
 * reasoning as the API flag: a deploy that never sets it launches in the
 * state phase 1 needs.
 *
 * `NEXT_PUBLIC_` rather than a plain env var because `Masthead` is a Client
 * Component (it needs `usePathname()` for nav highlighting) — a bare
 * `process.env` read there would be `undefined` in the browser after
 * hydration. `NEXT_PUBLIC_` vars are inlined at build time into both the
 * server-rendered HTML and the client bundle, so there is no
 * server/client mismatch to worry about, only a value fixed at build time —
 * exactly right for a phase toggle, which is not something that should
 * change mid-request anyway.
 */
export const BILLING_ENABLED = process.env["NEXT_PUBLIC_BILLING_ENABLED"] === "true";

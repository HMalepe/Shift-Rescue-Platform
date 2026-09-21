# Deploying the dashboard (`apps/web`) to Vercel

Companion to `docs/RAILWAY.md`, which deploys the API. Deploy the API first —
this app needs its public URL before it can be configured.

## Why there is no cross-domain auth problem to solve

`apps/web` is a back-end-for-front-end (see `src/lib/session.ts`). The
browser never calls the API directly, on any domain:

- The browser talks only to the Next.js server (Vercel), which sets its own
  `httpOnly` session cookies (`lp_at`, `lp_rt`) scoped to Vercel's own domain.
  JavaScript cannot read them; the browser could not attach them to a
  cross-origin request even if something tried to.
- The Next.js **server** — Server Components and Server Actions, running in
  Vercel's functions — calls the API with `Authorization: Bearer <token>` on
  every request. That is a server-to-server call, not a browser fetch, so
  CORS (a browser-only enforcement mechanism) never enters into it. The API
  registers no CORS plugin and needs none for this.
- The API itself sets no cookies and has no cookie plugin registered.

Two different domains, two different concerns, cleanly separated: the browser
↔ Vercel leg is cookie-based and same-origin; the Vercel ↔ Railway leg is
bearer-token and server-to-server. Nothing here changes when the two halves
move to separate hosts — that separation is what a BFF is for.

## Environment variable

One variable, `API_URL`, **not** `NEXT_PUBLIC_API_URL` — see the comment in
`apps/web/.env.example` for why the `NEXT_PUBLIC_` prefix would be a mistake
here (it inlines the value into the browser bundle, which nothing in this app
needs and which undoes the point of the httpOnly-cookie design).

In the Vercel project's Settings → Environment Variables, set:

```
API_URL = https://<your-api-service>.up.railway.app
ADMIN_EMAIL = you@example.com
ADMIN_PASSWORD = <at least 12 characters>
```

`ADMIN_EMAIL` / `ADMIN_PASSWORD` are server-only (no `NEXT_PUBLIC_` prefix).
They create the first admin: after a Production deploy, open `/setup` and
click Create. Do not put the password in the browser bundle.

for **Production** (and **Preview**, if you want preview deploys to work
against the same backend — otherwise point Preview at a separate staging API
if one exists). Use the Railway service's **public** URL — a
`*.railway.internal` hostname only resolves from other services inside
Railway's own private network, and Vercel's functions run outside it entirely.

## Project settings

1. **New Project → Import** this GitHub repo.
2. **Root Directory**: `apps/web`. Vercel auto-detects the pnpm workspace
   (`pnpm-workspace.yaml` at the repo root) and runs `pnpm install` from the
   repo root even with a subdirectory Root Directory set — this is Vercel's
   built-in monorepo support, and no `vercel.json` is needed for it.
3. **Framework Preset**: Next.js (auto-detected).
4. **Build/Install commands**: leave the defaults. `apps/web/package.json`'s
   `build` script is plain `next build`.

`apps/web` declares a workspace dependency on `@locum/api` (for a planned
end-to-end type import that is not wired up yet — nothing currently imports
from it; grep confirms no `from "@locum/api"` anywhere in `src/`). Nothing
runtime-breaking depends on that being resolved correctly, but it does mean
the install step needs the monorepo present — which the Root Directory
approach above already provides.

## After it deploys

Sign in through the deployed dashboard and confirm a page that requires
authentication loads. If it redirects to `/login` in a loop, check:

- `API_URL` is set and is the API's public URL, not `.railway.internal`.
- The API is actually reachable — `curl https://<api>.up.railway.app/health`.
- The API's own `PUBLIC_BASE_URL` (a *different* variable, set on the Railway
  side per `docs/RAILWAY.md`) is unrelated to this and does not need to match
  the Vercel domain — it is used only for Twilio webhook signature
  verification.

## What this does not cover

`apps/mobile` (the Expo locum app) is a separate client with its own API
base-URL configuration, not addressed here.

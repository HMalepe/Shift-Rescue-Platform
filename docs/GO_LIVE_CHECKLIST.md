# Manual end-to-end checklist: Vercel dashboard ↔ Railway API

Companion to `docs/RAILWAY.md` and `docs/VERCEL.md`. Run through this after
both are deployed and `API_URL` is set.

Two corrections baked into this list, not glossed over:

- **Redis is never touched by `apps/api`** — its config doesn't even declare
  `REDIS_URL`. Only the `worker` service connects to Redis (BullMQ). A check
  that hits the dashboard cannot prove Redis works; it has to look at the
  worker.
- **Payfast has no dashboard-reachable trigger.** No route in
  `apps/api/src/trpc/routers/*` calls `PaymentProvider`. Charges only fire
  from the worker's `billing.process-due-charges` job. There is no "pay now"
  button to click yet.

## 1. Dashboard loads (Vercel)

- [ ] Visit the Vercel URL. Login page renders, no 500/blank screen.
- [ ] Open DevTools → Console + Network, leave open for the rest of this list.

## 2. Login / auth succeeds

- [ ] Sign in with a real account. Lands on the role-appropriate home
      (`/browse`, `/shifts`, `/admin`).
- [ ] DevTools → Application → Cookies: `lp_at` / `lp_rt` present,
      `HttpOnly` + `Secure`.
- [ ] In the Console, run `document.cookie` — must print an **empty string**.
      That is the proof the tokens are unreadable by JS, not just "present."

## 3. A request that hits Postgres

- [ ] `curl https://<api>.up.railway.app/health` →
      `{"status":"healthy","databaseLatencyMs":N}` — a non-zero latency is a
      live `SELECT 1`, not a cached response.
- [ ] Load `/browse` or `/shifts` in the dashboard — lists real rows for the
      signed-in account.

## 4. A request that hits Redis (via the worker, not the API)

- [ ] **Fast**: `worker` service logs on Railway show a recurring line (e.g.
      `"drained deferred messages"`) firing on its own schedule — that is
      BullMQ reading from Redis.
- [ ] **Conclusive**: post a shift, toggle "Looking for a Locum." Ring 0 sends
      immediately and does NOT use Redis. Wait 12 minutes; if ring 1 offers
      appear in `shift_offers`, that escalation ran through BullMQ/Redis.

## 5. Twilio — a real message

- [ ] Favourite a locum with a real WhatsApp number and `whatsappOptInAt` set.
- [ ] Toggle "Looking for a Locum." Confirm the message actually arrives.
- [ ] `api` logs: no 401/403 *from Twilio* (bad `TWILIO_AUTH_TOKEN`/
      `TWILIO_ACCOUNT_SID`).
- [ ] `api` logs: no signature-verification failure on
      `POST /webhooks/twilio/status` (wrong `PUBLIC_BASE_URL` or auth token
      breaks this).

## 6. Payfast — verify at the source, since the dashboard can't trigger it

- [ ] Seed/insert a subscription row with a past due date.
- [ ] Trigger the worker job once (`railway run --service worker ...` or wait
      for its schedule).
- [ ] Payfast merchant dashboard shows the sandbox transaction.
- [ ] `worker` logs: no signature-mismatch or auth error.
- [ ] Known gap, not solved here: no user-facing "subscribe/pay now" flow
      exists in `apps/web` yet.

## 7. "No CORS errors" — nothing to check, structurally

CORS governs browser-to-server calls only. The browser here only ever talks
to Vercel; every other call (Postgres, Redis, Twilio, Payfast) is
server-to-server from Vercel's functions or Railway, which CORS doesn't
apply to. The real check: DevTools Network tab shows no failed requests, and
**no request ever goes directly from the browser to `*.railway.app` or a
vendor domain** — if one does, something regressed back to client-side
fetching and the BFF boundary has been broken.

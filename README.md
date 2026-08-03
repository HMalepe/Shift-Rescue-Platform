# Locum Planner

Two-sided marketplace connecting South African pharmacies with verified relief
pharmacists. Launch scope is Johannesburg and greater Gauteng.

A pharmacy legally cannot trade without a responsible pharmacist on the floor.
When one is sick or on leave, the manager has hours — sometimes minutes — to
find a registered replacement. Today that runs on WhatsApp groups, with no
verification, no reliability history, no distance logic and no record of who
actually worked.

See `docs/` for the full product and technical specification.

## Status

Phase 0 is complete except for what needs a third party or physical hardware.
Phases 1 and 2 are built. **335 tests, `make verify` green.**

| Area | State |
|---|---|
| Local parity stack (PG 16 + PostGIS 3.4 + Redis 7.4) | Done — `docker-compose.yml`, or `make up-native` without Docker |
| Schema, migrations, database-level invariants | Done — double-booking, evidence-required and money CHECKs proven by execution |
| Seed generator (§14) | Done — 5,200 accounts on real metro density |
| Load harness (§0.3) | Done and run — see the measured numbers in `packages/db/src/client.ts` |
| `make verify` (§0.4) | Done |
| Alerting + Phase 0 drill (§0.1) | Done — `make drill` fires it; the gate closes when a phone buzzes |
| Booking, attendance, verification, messaging, billing | Done (§4–§9, §11) |
| Reputation with density-aware anonymisation (§7) | Done |
| Phase 3 proactive matching (§12.3) | Done — escalating rings, two-sided distance, capped fan-out, `shifts.lookingForLocum` |
| §12.3 combined load-test gate | Run — contention and fan-out together: 19/20 filled, 600 offers, every invariant clean |
| POPIA access and erasure (§10) | Done |
| Ops dashboard + on-call (§12.2) | Done |
| Web client | Done — `apps/web` |
| Vendor adapters (§0.2) | Done — Twilio, Payfast, S3, ClamAV, all tested against something real |
| Malware scanning (§12.1) | Done — clamd over INSTREAM, fails closed; no "unknown" verdict exists |
| Production boot (§0.2) | Verified — `assertProductionReady` passes and the API serves with real adapters wired |
| Container image | Written — `Dockerfile`. Never built: no Docker daemon available here |
| Terraform (§0.1) | Written and validated against the real AWS provider schema. **Never planned, never applied** |
| Staging environment (§0.1) | **Blocked** — needs AWS credentials |
| Vendor sandboxes (§0.2) | **Blocked** — needs a Payfast account and an approved Meta sender |
| Mobile (Expo) | Built — `apps/mobile`. The anti-spoofing gate still needs a physical Android device (§16) |

Every gate in `gates.json` is recorded as `executed`, not `passed`. §15 is
explicit that execution gates close against a live environment and external
ones on written return; none has an evidence URL yet, and calling any of them
`passed` would be the exact drift §12.5 exists to prevent.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Database | Postgres 16 + PostGIS 3.4 | Proximity matching is core. §0.1 requires version parity — row-locking and planner behaviour do not port. |
| ORM | Drizzle | Real PostGIS types, explicit `FOR UPDATE`, and readable `EXPLAIN ANALYZE` — which §15 makes a hard gate. Prisma obscures all three. |
| API | Fastify + tRPC | End-to-end types shared by web and mobile. |
| Domain logic | `packages/core` | Framework-agnostic, so booking row-locking lives in one place callable from API and worker alike, and is trivially mutation-testable (§12.4). |
| Queues | BullMQ + Redis | Quiet-hours deferral (§4.4), dunning retries (§2), notification fan-out (§12.3). |
| Web | Next.js 16 | Manager console + admin verification queue. |
| Mobile | Expo (React Native) | §16: anti-spoofing needs Android `isFromMockProvider()`. No browser equivalent exists, so a PWA cannot close that gate. |
| Hosting | AWS af-south-1 (Cape Town) | Latency to Gauteng users and POPIA data residency. Terraform for the single-command redeploy §0.1 requires. |

## Repository layout

```
packages/db             Drizzle schema, migrations, PostGIS types, seed generator
packages/core           Framework-agnostic domain services — booking, auth,
                        attendance, messaging, billing, reputation, privacy
packages/observability  Error classification, alert transport, §0.1 drill
packages/integrations   Real vendor adapters — Twilio WhatsApp, Payfast, S3,
                        ClamAV malware scanning
apps/api                Fastify + tRPC, Twilio webhooks, REST auth
apps/worker             BullMQ processors — quiet-hours drain, dunning, sweeps
apps/web                Next.js client for all three roles
apps/mobile             Expo locum app — browse, apply, check in/out
tools/loadtest          k6 harness (§0.3)
tools/devdata           Local sign-ins for the seeded fixtures
infra/                  Terraform, af-south-1 — validates against the real
                        provider schema; never planned, never applied
```

## Getting started

```bash
make install       # install workspace dependencies
make up            # Postgres + Redis via Docker...
make up-native     # ...or without a Docker daemon
make migrate
make seed          # §14 fixtures — 5,200 accounts, real metro density
make dev-users     # give those fixtures a password, and create an admin
make verify        # §0.4 — typecheck, lint, 335 tests. Exits non-zero on failure.
```

Then, in three terminals:

```bash
pnpm --filter @locum/api start     # :3000
pnpm --filter @locum/web dev       # :3001
make worker                        # scheduled jobs
```

`make dev-users` prints the sign-ins. The seed deliberately writes no password
hashes — it exists to produce realistic *data* for load tests and query plans,
and 5,200 live credentials in a fixture would be a liability — so without that
step the seeded world is complete and impossible to log into.

Useful targets: `make gates` rebuilds the §12.5 ledger from `gates.json`,
`make loadtest` runs the §0.3 harness, `make drill` fires the §0.1 alerting
drill against a target that has it enabled.

## Design notes worth reading before changing code

**The platform never touches locum wages.** (§10.0) Not held, not routed, not
escrowed, no percentage taken. The only money flow is a pharmacy's flat monthly
subscription plus the R10 late-cancellation charge. This is a legal boundary —
it materially reduces exposure on employment misclassification — not a phase-1
simplification. There is deliberately no payout code path, and adding one
changes the product's legal position.

**Double-booking is prevented by the database, not by application code.** Two
locums confirmed against one shift means one travels to a shift that is not
theirs; zero confirmed when the manager believes there is one means the
pharmacy cannot open. `bookings_one_confirmed_per_shift` is a partial unique
index, so the invariant holds even if the surrounding code is wrong. The
`SELECT ... FOR UPDATE` in the confirm path exists to turn the loser of a race
into a clean domain error rather than a raw constraint violation.

**Coordinates are `geography`, not `geometry`.** Distance matching is expressed
in kilometres, and `geography` measures metres on the spheroid, so
`ST_DWithin(a, b, 15000)` is honestly 15 km. `geometry` measures in degrees,
which are not a constant distance apart.

**Money is integer cents.** Never a float, in a column pharmacies reconcile
against payroll.

**Rate limits are keyed on the account, not the IP.** (§12.1) The per-IP limit
stays for credential stuffing, where the attacker has no account. It is the
wrong control for scraping: a locum enumerating the shift board is already
authenticated and gets a new IP by switching to mobile data, while a pharmacy
group behind one NAT shares a bucket and gets locked out for someone else's
behaviour.

**Erasure keeps the no-show count.** (§10/§7) Everything identifying goes.
The shift-history counters stay, because clearing them would make the erasure
endpoint a reputation reset — three no-shows, delete, re-register, clean
record. `packages/core/src/privacy/retention.ts` records a decision, with its
reasoning, for every table; a new table without one fails the build.

**A pager that fires on correct behaviour is a pager nobody reads.** (§0.1)
`packages/observability/src/reporter.ts` decides severity in one place. Every
403 and 409 this API correctly returns is `routine` and never alerts. The three
worst failures here raise no exception at all — a shift that started unfilled,
a deferred message past due, a charge with no answer from the provider — and
live on `/admin/dashboard` instead. `docs/ONCALL.md` has the rest.

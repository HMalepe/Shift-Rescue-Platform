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

**Phase 0 — verification environment.** Per §0 of the spec, the environment
where gates get passed is built *ahead of* feature work. Feature development
has not started.

| Phase 0 item | State |
|---|---|
| Local parity stack (PG 16 + PostGIS 3.4 + Redis 7.4) | Done — `docker-compose.yml` |
| Database schema + migrations | Done — applied and verified against live PostGIS |
| Database-level invariants | Done — double-booking, evidence-required, money/window CHECKs all proven by execution |
| Seed generator (§14) | Not started |
| Load harness (§0.3) | Not started |
| `make verify` (§0.4) | Partial — typecheck/lint/test wired; gates still to come |
| Staging environment (§0.1) | Not started |
| Vendor sandboxes (§0.2) | Not started |

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
packages/db       Drizzle schema, migrations, PostGIS types, seed generator
packages/core     Framework-agnostic domain services  (planned)
packages/contracts Shared zod schemas                 (planned)
apps/api          Fastify + tRPC, Twilio/Payfast webhooks (planned)
apps/worker       BullMQ processors                   (planned)
apps/web          Next.js manager + admin console     (planned)
apps/mobile       Expo locum app                      (planned)
tools/loadtest    k6 harness (§0.3)                   (planned)
infra/            Terraform, af-south-1               (planned)
```

## Getting started

```bash
make install     # install workspace dependencies
make up          # start Postgres+PostGIS and Redis
make migrate     # apply migrations
make verify      # §0.4 — full verification run
```

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

# One image, two services.
#
# infra/compute.tf runs the same image for the API and the worker, with
# different commands. That is deliberate: the worker consumes jobs the API
# enqueues, and two images means two deploy pipelines that can drift, so a
# worker can end up running different code from the API that queued the work —
# a class of bug that shows up as a job failing on a payload shape nobody
# recognises.
#
# ## Node 22 and ARM64
#
# Node 22 matches `engines` in package.json and the version CI runs. ARM64
# matches the `runtime_platform` in both ECS task definitions (infra/) —
# building for that path on an x86 machine needs
# `docker buildx build --platform linux/arm64`, and a mismatch fails at task
# start with an exec format error rather than at build time.
#
# This only applies to the ECS/infra path. The Railway MVP path
# (docs/RAILWAY.md) has no `runtime_platform` to match — Railway builds this
# same Dockerfile natively for its own runtime, so no `--platform` override is
# needed or wanted there.
#
# ## Compiled runtime, not tsx
#
# This used to ship the whole TypeScript toolchain (tsx, typescript, vitest)
# into the runtime image, because neither app had a build step and starting
# from `tsx src/main.ts` was the only option. That tradeoff is resolved now:
# apps/api and apps/worker each bundle to a single dist/main.js via
# scripts/build-node-app.mjs (esbuild, Node 22 target, ESM); `@locum/db`
# bundles the same way to dist/migrate.js, since railway.json's own
# `deploy.preDeployCommand` runs `pnpm --filter @locum/db migrate` against
# this image, not just the two apps' `start`. This Dockerfile is a genuine
# multi-stage build — `deps` and `build` see the full devDependency tree,
# `prod-deps` installs production dependencies ONLY for `@locum/api`,
# `@locum/worker`, `@locum/db` and their transitive graph, and `runtime`
# copies just that plus the three dist/*.js entrypoints (plus
# packages/db/migrations, which is data read by name at migrate time, not
# compiled). tsx, typescript, vitest and esbuild itself never reach the
# shipped image; neither does any `src/` tree — the bundles are
# self-contained.
#
# Native modules — the one way this class of change breaks in a way `docker
# build` succeeding does not catch — are never bundled. See
# scripts/build-node-app.mjs's own header for the full external list and the
# reasoning per package; the short version is that `@node-rs/argon2`,
# `postgres`, `bullmq`, `ioredis`, `pino`, `drizzle-orm`, `fastify` and its
# official plugins all stay real node_modules packages, resolved by Node
# exactly as before, with apps/api and apps/worker's own package.json now
# listing whichever of them their bundle actually imports directly (a
# dependency that used to arrive transitively through `@locum/core`/
# `@locum/db` is not resolvable from apps/api/dist/main.js's location once
# bundled — pnpm only symlinks a package's OWN direct dependencies into its
# node_modules, not a workspace sibling's).

FROM node:22-bookworm-slim AS deps

# corepack pins pnpm to the version in packageManager, so the lockfile is
# resolved by the same pnpm that wrote it.
RUN corepack enable

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the whole
# workspace. Every package.json is needed because pnpm resolves workspace
# links at install time and fails on a missing member.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/observability/package.json packages/observability/
COPY tools/loadtest/package.json tools/loadtest/
COPY tools/devdata/package.json tools/devdata/

# No cache mount, deliberately, after two failed round-trips on this exact
# line: first with no `id=` (Railway's builder: "is missing an id
# argument"), then with `id=pnpm-store` (also rejected, by the same builder,
# with no clearer error surfaced in the build log than "failed to build an
# image"). Neither the BuildKit spec nor Railway's own docs pin down what
# `id=` value its builder actually wants, and this line has now cost three
# build attempts guessing at it. A plain, mount-free `pnpm install` gives up
# the cross-build cache reuse between this Dockerfile's two targets (api and
# worker both install from the same lockfile) in exchange for a build that
# cannot fail on cache-mount syntax again. Revisit only with a confirmed
# working example from Railway's own docs in hand, not another guess.
RUN PNPM_HOME=/pnpm pnpm install --frozen-lockfile

# --- build: compile apps/api and apps/worker to dist/main.js -----------------

FROM deps AS build

COPY scripts/build-node-app.mjs scripts/
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/integrations packages/integrations
COPY packages/observability packages/observability

# turbo, not a bare `pnpm --filter ... build`, so `^build`'s dependsOn
# ordering is real rather than assumed — see turbo.json. Neither app has a
# workspace-package build dependency today (packages/core etc. only
# typecheck; esbuild reads their TypeScript source directly through each
# package's own `exports` map), so this is currently equivalent to running
# each app's own build script in isolation — but "currently" is the
# operative word, and turbo is what keeps that true if that ever changes
# without anyone having to remember why.
#
# @locum/db is included here too: railway.json's `deploy.preDeployCommand`
# runs `pnpm --filter @locum/db migrate` against the runtime image, same as
# apps/api and apps/worker's own start commands — it needs the same compiled
# path, not `tsx src/migrate.ts`, or it fails the moment tsx and src/ stop
# shipping to that image.
RUN pnpm exec turbo run build --filter=@locum/api --filter=@locum/worker --filter=@locum/db

# --- prod-deps: a production-only install, scoped to api + worker -----------

FROM node:22-bookworm-slim AS prod-deps

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/observability/package.json packages/observability/
COPY tools/loadtest/package.json tools/loadtest/
COPY tools/devdata/package.json tools/devdata/

# `--prod` drops every devDependency across the whole resolved tree —
# typescript, tsx, vitest, esbuild, drizzle-kit, eslint, all of it — and
# `--filter=...` scopes the install to `@locum/api`/`@locum/worker`/`@locum/db`
# and whatever they actually depend on, rather than also installing Next.js
# and the mobile app's dependencies into an image that runs neither. This is
# the entire size/attack-surface reduction the Dockerfile's own header used
# to apologise for not having done.
#
# `@locum/db` is included because railway.json's `deploy.preDeployCommand`
# runs its `migrate` script against this same runtime image, not just
# apps/api and apps/worker's own `start`.
RUN PNPM_HOME=/pnpm pnpm install --prod --frozen-lockfile \
    --filter=@locum/api... --filter=@locum/worker... --filter=@locum/db...

# --- runtime -------------------------------------------------------------

FROM node:22-bookworm-slim AS runtime

RUN corepack enable

# `tini` as PID 1.
#
# Node as PID 1 does not reap zombies and does not get the default signal
# handlers — and SIGTERM handling is load-bearing here. apps/api/src/main.ts
# drains in-flight requests on SIGTERM specifically so a booking confirmation
# is not killed mid-transaction, and ECS sends SIGTERM before SIGKILL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests only — no package's `src/` reaches this stage at all, compiled or
# not (packages/db/migrations is the one exception, copied below — it is
# data, not source). `pnpm --filter @locum/api start` and `pnpm --filter
# @locum/db migrate` (what railway.json's `deploy.startCommand` /
# `deploy.preDeployCommand`, and infra/compute.tf's ECS `command`, actually
# invoke) still need the full workspace graph to resolve the filter, even
# though none of the three packages they can target need anything else from
# their workspace siblings — see the header comment on why a bundled
# dist/main.js or dist/migrate.js has nothing left to import from
# `@locum/core` et al. by name.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/observability/package.json packages/observability/
COPY tools/loadtest/package.json tools/loadtest/
COPY tools/devdata/package.json tools/devdata/

# The production-only node_modules tree, and nothing else — no devtools, no
# src.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules

# The compiled bundles. Each is a single file (plus a sourcemap, kept for
# readable stack traces in error reports) — everything from
# packages/core/db/integrations/observability is already inlined into
# apps/api's and apps/worker's own bundle. packages/db/dist/migrate.js is
# separate: it is what railway.json's `deploy.preDeployCommand` runs
# directly (`pnpm --filter @locum/db migrate`), so it needs to exist here in
# its own right, not just inlined into someone else's bundle.
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/db/dist packages/db/dist

# Not compiled — read from disk at migration time by name (drizzle's
# migrator walks this directory for both the .sql files and its own
# meta/_journal.json), so it ships as data, the same way it always did.
COPY packages/db/migrations packages/db/migrations

# Non-root. The node image ships a `node` user; the application never needs to
# write to its own directory, so ownership stays with root and the process
# simply cannot modify its own code.
USER node

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]

# Overridden for the worker by the ECS task definition's `command`, and by
# railway.worker.json's own `deploy.startCommand` on the Railway path.
CMD ["pnpm", "--filter", "@locum/api", "start"]

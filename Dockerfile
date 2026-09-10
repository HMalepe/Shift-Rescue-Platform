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
# matches the `runtime_platform` in both ECS task definitions; building this on
# an x86 machine needs `docker buildx build --platform linux/arm64`, and a
# mismatch fails at task start with an exec format error rather than at build
# time.
#
# ## Why this ships TypeScript rather than compiled JavaScript
#
# Both apps start with `tsx src/main.ts`, and none of the workspace packages
# has a build step — `packages/core` only typechecks. So there is no compiled
# output to copy, and a `--prod` install would drop `tsx` and leave an image
# that cannot start.
#
# The honest cost: this image carries devDependencies, including the whole
# TypeScript toolchain and vitest. That is more bytes and more attack surface
# than a compiled image needs. It is not a decision worth hiding, and the fix
# is to add real build steps to the apps rather than to prune here — pruning
# `tsx` is exactly what would break it.
#
# ## Not built or run here
#
# There is no Docker daemon in the environment this was written in, so this
# Dockerfile has never been built and the image has never started. Treat it the
# same way as infra/: reviewed, not verified.

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

# An explicit `id=` is required, not optional: Railway's current builder
# ("Metal") rejects this exact flag with "is missing an id argument" if it is
# left off, which contradicts what an earlier commit here assumed (that
# dropping `id=` let BuildKit derive one from the mount target, and that a
# bare id was what got rejected). That assumption had never actually been
# built on Railway — the header comment above says so — and Railway's own
# build log is the correction. `pnpm-store` is shared between this
# Dockerfile's two build targets (api and worker both install from the same
# lockfile), which is the point of a cache mount: the second service's build
# reuses whatever the first already downloaded.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    PNPM_HOME=/pnpm pnpm install --frozen-lockfile

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

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/integrations/node_modules ./packages/integrations/node_modules
COPY --from=deps /app/packages/observability/node_modules ./packages/observability/node_modules

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/integrations packages/integrations
COPY packages/observability packages/observability

# Non-root. The node image ships a `node` user; the application never needs to
# write to its own directory, so ownership stays with root and the process
# simply cannot modify its own code.
USER node

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]

# Overridden for the worker by the ECS task definition's `command`.
CMD ["pnpm", "--filter", "@locum/api", "start"]

# Locum Planner
#
# §0.4 requires a single-command verification run that exits non-zero on
# failure. That command is `make verify`.

SHELL := /bin/bash
.DEFAULT_GOAL := help

DATABASE_URL ?= postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev
AUTH_SECRET ?= local-dev-auth-secret-at-least-32-chars
# The worker's gate tests exercise real BullMQ schedules against real Redis.
# Mocking the queue would test the mock: the failures worth catching (a
# repeatable schedule surviving a rename, a job firing twice per deploy) are
# properties of what Redis remembers, not of the calling code.
REDIS_URL ?= redis://localhost:6379
DRILL_TARGET ?= http://localhost:3000
export AUTH_SECRET
export DATABASE_URL
export REDIS_URL

.PHONY: help
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install workspace dependencies
	pnpm install --frozen-lockfile

.PHONY: up
up: ## Start local Postgres+PostGIS and Redis
	docker compose up -d --wait

.PHONY: up-native
up-native: ## Start Postgres+PostGIS and Redis without Docker
	bash scripts/local-pg.sh
	bash scripts/local-redis.sh

.PHONY: down
down: ## Stop local infrastructure
	docker compose down

.PHONY: reset
reset: ## Destroy and rebuild local infrastructure from scratch
	# §0.1: teardown/rebuild must be cheap enough that a destructive
	# security test is not scary.
	docker compose down -v
	docker compose up -d --wait
	$(MAKE) migrate

.PHONY: migrate
migrate: ## Apply database migrations
	pnpm --filter @locum/db migrate

.PHONY: generate
generate: ## Regenerate migrations from the Drizzle schema
	pnpm --filter @locum/db generate

.PHONY: seed
seed: ## Seed realistic test data (§14)
	pnpm --filter @locum/db seed

.PHONY: dev-users
dev-users: ## Give the seeded fixtures a password and create an admin (local only)
	pnpm --filter @locum/devdata dev-users

.PHONY: gates
gates: ## §12.5 — reconstruct the gate ledger in verification_runs from gates.json
	pnpm --filter @locum/db gates

.PHONY: worker
worker: ## Run the scheduled-jobs worker (§4.4 drain, §2 dunning)
	pnpm --filter @locum/worker start

.PHONY: infra-validate
infra-validate: ## Validate the Terraform against the real AWS provider schema
	# Not part of `make verify`: it needs the provider downloaded, which this
	# environment can only do through a filesystem mirror (see infra/README.md).
	# `validate` checks resource and attribute names against the provider's own
	# schema — it does NOT plan, and nothing here has ever been applied.
	cd infra && terraform init -backend=false -input=false >/dev/null && \
		terraform fmt -check -recursive && terraform validate

.PHONY: typecheck
typecheck: ## Typecheck every package
	pnpm turbo run typecheck

.PHONY: lint
lint: ## Lint every package
	pnpm turbo run lint

.PHONY: test-dbs
test-dbs: ## Give each package its own test database, cloned from a seeded template
	bash scripts/test-dbs.sh

.PHONY: test
test: ## Run the test suite
	# Packages run in parallel and used to share one database, which made the
	# §4.4 drain gates claim each other's rows about one run in three. See
	# scripts/test-dbs.sh for the diagnosis; it is cheap (template clone) and
	# idempotent, so it runs every time rather than being a step to remember.
	bash scripts/test-dbs.sh
	pnpm turbo run test

##@ Gates

.PHONY: verify
verify: ## §0.4 — full verification run; non-zero exit on any failure
	@set -e; \
	echo "==> typecheck"; $(MAKE) --no-print-directory typecheck; \
	echo "==> lint";      $(MAKE) --no-print-directory lint; \
	echo "==> test";      $(MAKE) --no-print-directory test; \
	echo ""; \
	echo "verify: all checks passed"

.PHONY: drill
drill: ## §0.1 — fire the deliberately broken endpoint and check an alert goes out
	# Phase 0's exit criterion. Requires DRILL_ENABLED=true and DRILL_SECRET on
	# the target, which production refuses to boot with — so this only ever
	# runs against staging or local.
	@test -n "$(DRILL_SECRET)" || { echo "set DRILL_SECRET (and DRILL_ENABLED=true on the target)"; exit 1; }
	@echo "==> firing drill at $(DRILL_TARGET)"
	@curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
		-H "x-drill-secret: $(DRILL_SECRET)" \
		"$(DRILL_TARGET)/__drill/boom" \
		| grep -q 500 && echo "drill fired; now confirm a human was paged (§15: the gate is that a phone buzzes)"

.PHONY: loadtest
loadtest: ## §0.3/§12.3 — prepare fixtures, run k6, verify the invariant
	# One command, per §0.3. Parameterised by environment variables:
	#   LOADTEST_CONTENDED_SHIFTS, LOADTEST_APPLICANTS_PER_SHIFT,
	#   LOADTEST_FAVOURITES, LOADTEST_CONFIRM_VUS, LOADTEST_DURATION
	# The verify step is what closes the gate: k6 measures latency, but whether
	# the row lock held is a database question answered after the run.
	# THE TARGET API MUST BE STARTED WITH A RAISED PER-IP LIMIT:
	#
	#   RATE_LIMIT_MAX=100000 pnpm --filter @locum/api start
	#
	# k6 drives every request from one address, so §12.1's per-IP limiter
	# (100/min by default) trips within seconds and the run measures the rate
	# limiter instead of the system. The first combined run failed 93% of
	# browse calls that way, which looked like a database problem and was not.
	#
	# The per-ACCOUNT quotas are deliberately left alone: those are per-token,
	# the fixtures spread across many tokens, and the fan-out quota firing
	# under a sustained toggle burst is correct behaviour the run should see.
	@command -v k6 >/dev/null || { echo "k6 not installed: https://k6.io/docs/get-started/installation/"; exit 1; }
	cd tools/loadtest && pnpm run prepare-fixtures
	cd tools/loadtest && k6 run k6/booking-contention.js
	cd tools/loadtest && pnpm run verify

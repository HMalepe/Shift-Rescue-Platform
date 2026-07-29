# Locum Planner
#
# §0.4 requires a single-command verification run that exits non-zero on
# failure. That command is `make verify`.

SHELL := /bin/bash
.DEFAULT_GOAL := help

DATABASE_URL ?= postgresql://locum:locum_local_dev@localhost:5432/locum_planner_dev
export DATABASE_URL

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

.PHONY: typecheck
typecheck: ## Typecheck every package
	pnpm turbo run typecheck

.PHONY: lint
lint: ## Lint every package
	pnpm turbo run lint

.PHONY: test
test: ## Run the test suite
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

.PHONY: loadtest
loadtest: ## §0.3/§12.3 — run the load harness against a target
	# Parameterised by concurrency and dataset size; see tools/loadtest.
	pnpm --filter @locum/loadtest run start

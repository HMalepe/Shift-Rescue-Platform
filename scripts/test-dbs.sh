#!/usr/bin/env bash
# Gives every package that touches Postgres its own test database.
#
# ## Why this exists
#
# `make verify` runs packages in parallel through turbo, and they all pointed
# at one database. Three of them write to `whatsapp_message_log`, and two of
# them CLAIM from it — `claimDueMessages` takes whatever is due, by design,
# because in production there is exactly one queue and a worker is supposed to
# drain all of it.
#
# `apps/worker/test/scheduler.test.ts` runs the real drain with `now` pushed 24
# hours ahead so its own row is due. That also makes every other package's rows
# due, and the batch size is 50. So the worker's drain claimed rows created by
# `packages/core`, and core's drain claimed the worker's row. Both directions
# were reproduced: core's "claims no more than the batch size" returned fewer
# than 3, and the worker's seam test asserted `sender.sent` had length 1 and
# got `[]`.
#
# It failed roughly one run in three, which is the worst possible rate — often
# enough to be real, rarely enough to look like something else. The §12.5
# ledger records these as executed gates, so a gate that passes two runs out of
# three is not evidence of anything.
#
# ## Why a template database
#
# The core gate tests need the §14 seed (5 000 locums, 200 pharmacies), and
# seeding four databases per run would add most of a minute. `CREATE DATABASE
# ... TEMPLATE` copies at the file level, so each package gets an identical,
# fully-seeded database in well under a second.
#
# Dropped and recreated on every run, deliberately: a test database that
# accumulates state across runs eventually develops its own opinions, and the
# whole point here is that a package's rows are only its own.
set -euo pipefail

PGPORT=${PGPORT:-5432}
PGHOST=${PGHOST:-127.0.0.1}
TEMPLATE=${TEMPLATE_DB:-locum_test_template}
PACKAGES=${TEST_DB_PACKAGES:-core api worker db}

# The admin connection creates and drops databases, so it must connect to a
# maintenance database — never to one of the databases being dropped.
#
# Locally the superuser is `postgres`. In CI the postgis service container is
# initialised with `locum` as superuser and there is no `postgres` role at all.
# The first version of this script hard-coded `-U postgres` and broke CI, which
# I did not notice because CI cannot run from here. Both are variables now, and
# the default is the local case.
ADMIN_URL=${TEST_DB_ADMIN_URL:-postgresql://postgres@${PGHOST}:${PGPORT}/postgres}
OWNER=${TEST_DB_OWNER:-locum}
OWNER_PASSWORD=${TEST_DB_OWNER_PASSWORD:-locum_local_dev}

admin() { psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 "$@"; }

exists() {
  admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'" | grep -q 1
}

# Fail on the connection, not three steps later on a confusing consequence of
# it. `exists` returns "no" for an unreachable server, which without this reads
# as "the template is missing" and reports a build failure instead of a box
# that is not running Postgres.
if ! admin -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "cannot reach Postgres at $ADMIN_URL" >&2
  echo "start it with \`bash scripts/local-pg.sh\` (or \`make up\` with Docker)" >&2
  exit 1
fi

# The template is built once and reused. `--rebuild` forces it, which is what
# you want after a migration or a change to the seed.
if [ "${1:-}" = "--rebuild" ] && exists "$TEMPLATE"; then
  echo "==> dropping $TEMPLATE"
  admin -c "DROP DATABASE $TEMPLATE"
fi

if ! exists "$TEMPLATE"; then
  echo "==> building $TEMPLATE (migrate + seed)"
  admin -c "CREATE DATABASE $TEMPLATE OWNER $OWNER"
  template_url="postgresql://${OWNER}:${OWNER_PASSWORD}@${PGHOST}:${PGPORT}/${TEMPLATE}"
  # SEED_LOCUMS / SEED_PHARMACIES are read from the environment by the seed
  # itself, so CI's smaller fixture set applies here without being restated.
  DATABASE_URL="$template_url" pnpm --filter @locum/db migrate
  DATABASE_URL="$template_url" pnpm --filter @locum/db seed
fi

for pkg in $PACKAGES; do
  db="locum_test_${pkg}"
  # TEMPLATE requires no other session connected to the source, and copying
  # into an existing name is not possible, so both are handled up front.
  admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname IN ('$db', '$TEMPLATE') AND pid <> pg_backend_pid()" >/dev/null
  admin -c "DROP DATABASE IF EXISTS $db"
  admin -c "CREATE DATABASE $db TEMPLATE $TEMPLATE OWNER $OWNER"
  echo "  $db"
done

echo "test databases ready (template: $TEMPLATE, owner: $OWNER)"

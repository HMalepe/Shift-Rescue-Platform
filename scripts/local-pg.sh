#!/usr/bin/env bash
# Starts a local Postgres 16 + PostGIS 3.4 cluster WITHOUT Docker.
#
# docker-compose.yml is the normal path and stays the source of truth for
# versions. This script exists for environments where no Docker daemon is
# available (CI sandboxes, some remote dev containers) but the postgresql-16
# and postgresql-16-postgis-3 packages can be installed. It keeps the same
# major/extension versions so §0.1 parity still holds.
#
# Usage:  ./scripts/local-pg.sh            # start (idempotent)
#         ./scripts/local-pg.sh migrate    # start, then migrate + seed
set -euo pipefail

PGDATA=${PGDATA:-/var/lib/pgdata}
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGPORT=${PGPORT:-5432}
PGDB=${PGDB:-locum_planner_dev}
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${PGDB}"

if ! command -v "$PGBIN/pg_ctl" >/dev/null 2>&1; then
  echo "postgres 16 binaries not found at $PGBIN" >&2
  echo "install with: apt-get install -y postgresql-16 postgresql-16-postgis-3" >&2
  exit 1
fi

if [ ! -d "$PGDATA/base" ]; then
  echo "==> initdb"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  su postgres -c "$PGBIN/initdb -D $PGDATA -E UTF8 --locale=C" >/dev/null
fi

if ! pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then
  echo "==> starting postgres on :$PGPORT"
  su postgres -c \
    "$PGBIN/pg_ctl -D $PGDATA -l /tmp/pg.log -o '-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1' start" \
    >/dev/null
  for _ in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 || {
  echo "postgres failed to start; see /tmp/pg.log" >&2
  tail -20 /tmp/pg.log >&2
  exit 1
}

if ! psql -h 127.0.0.1 -p "$PGPORT" -U postgres -lqt | cut -d'|' -f1 | grep -qw "$PGDB"; then
  echo "==> creating $PGDB"
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q -c "CREATE DATABASE $PGDB"
fi

# The `locum` role, matching .env.example and the Makefile's DATABASE_URL
# default. Created here rather than left to whoever first hits it, because a
# reaped container reinitialises the cluster and the whole test suite then
# fails with `role "locum" does not exist` — a message that reads like a
# configuration bug rather than a missing role in a throwaway database.
psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'locum') THEN
    CREATE ROLE locum LOGIN PASSWORD 'locum_local_dev' SUPERUSER;
  END IF;
END \$\$;
SQL
psql -h 127.0.0.1 -p "$PGPORT" -U postgres -q \
  -c "GRANT ALL PRIVILEGES ON DATABASE $PGDB TO locum"

echo "postgres ready: $DATABASE_URL"
psql "$DATABASE_URL" -tAc "SELECT 'PostGIS ' || postgis_version()" 2>/dev/null \
  || echo "(postgis extension not yet created; migrations will create it)"

if [ "${1:-}" = "migrate" ]; then
  echo "==> migrate"
  pnpm --filter @locum/db migrate
  echo "==> seed"
  pnpm --filter @locum/db seed
fi

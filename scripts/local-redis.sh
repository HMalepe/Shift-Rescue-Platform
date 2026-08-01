#!/usr/bin/env bash
# Starts Redis without Docker.
#
# docker-compose.yml is the documented local stack, but no Docker daemon runs
# in every environment this repo gets built in (CI containers, cloud dev
# sandboxes), and the worker's gate tests need a real Redis rather than a mock
# — the failures worth catching are properties of what Redis remembers across
# a restart.
set -euo pipefail

PORT="${REDIS_PORT:-6379}"

if redis-cli -p "$PORT" ping >/dev/null 2>&1; then
  echo "redis already running on :$PORT"
  exit 0
fi

echo "==> starting redis on :$PORT"
redis-server --port "$PORT" --daemonize yes --save '' --appendonly no \
  --logfile /tmp/redis.log

for _ in $(seq 1 40); do
  if redis-cli -p "$PORT" ping >/dev/null 2>&1; then
    echo "redis ready: redis://localhost:$PORT"
    exit 0
  fi
  sleep 0.25
done

echo "redis failed to start; see /tmp/redis.log" >&2
tail -20 /tmp/redis.log >&2
exit 1

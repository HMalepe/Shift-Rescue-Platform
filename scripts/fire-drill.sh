#!/usr/bin/env bash
# §0.1 — fires the deliberately broken alerting-drill endpoint and confirms
# it actually failed the way it is supposed to.
#
# packages/observability/src/drill.ts's own header explains why this endpoint
# exists at all: Phase 0's exit criterion required proving a deliberately
# broken endpoint on staging produces a real alert, before any Phase 1
# feature work started — and that step was skipped. This script exists so
# "fire the drill and confirm the alert lands" is a single, repeatable,
# CI-automatable command instead of a hand-typed curl someone has to
# remember the exact header and path for.
#
# ################################################################
# # DRILL_ENABLED must NEVER be true in production. This script  #
# # must NEVER be pointed at a production URL. §0.1's own gate   #
# # already refuses this: `assertProductionReady` (apps/api/src/ #
# # config.ts) refuses to boot with DRILL_ENABLED=true, so a     #
# # correctly configured production instance will 404 this call  #
# # (drill_disabled) rather than fire — but that is a second     #
# # line of defence, not a licence to point this at prod anyway. #
# # Staging or local only.                                       #
# ################################################################
#
# Usage:
#   DRILL_SECRET=<secret> ./scripts/fire-drill.sh https://staging-api.example.com
#   DRILL_SECRET=<secret> PUBLIC_BASE_URL=https://staging-api.example.com ./scripts/fire-drill.sh
#
# The target base URL is the first argument, falling back to PUBLIC_BASE_URL
# if omitted — the same variable the API itself uses to describe its own
# public origin (apps/api/src/config.ts), so a value already sitting in a
# staging .env can be reused verbatim rather than retyped.
#
# Exit code is 0 only when the drill fired exactly as designed (HTTP 500,
# body naming "drill_fired") — anything else, including a 200, a 404 (drill
# disabled), a 401 (wrong secret) or a network failure, is a non-zero exit,
# so this is safe to wire into CI as a real gate rather than something a
# human has to eyeball.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TSX="$REPO_ROOT/node_modules/.bin/tsx"

BASE_URL="${1:-${PUBLIC_BASE_URL:-}}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url>   (or set PUBLIC_BASE_URL)" >&2
  exit 2
fi
# Strip a trailing slash so "$BASE_URL$DRILL_PATH" never doubles up on "/".
BASE_URL="${BASE_URL%/}"

if [ -z "${DRILL_SECRET:-}" ]; then
  echo "error: DRILL_SECRET env var is required" >&2
  exit 2
fi

if [ ! -x "$TSX" ]; then
  echo "error: tsx not found at $TSX — run 'pnpm install' at the repo root first" >&2
  exit 2
fi

# Resolved from @locum/observability's own DRILL_PATH export rather than
# hardcoded here — a path guessed once and copy-pasted into three places
# (server.ts, the Makefile, this script) is exactly how the old inline `make
# drill` recipe went stale the moment drill.ts's own path ever changed.
RESOLVE_SCRIPT="$(mktemp -t fire-drill-resolve-XXXXXX.mts)"
RESPONSE_BODY="$(mktemp -t fire-drill-response-XXXXXX)"
trap 'rm -f "$RESOLVE_SCRIPT" "$RESPONSE_BODY"' EXIT

cat >"$RESOLVE_SCRIPT" <<EOF
import { DRILL_PATH } from "$REPO_ROOT/packages/observability/src/drill.ts";
process.stdout.write(DRILL_PATH);
EOF

DRILL_PATH="$("$TSX" "$RESOLVE_SCRIPT")"
if [ -z "$DRILL_PATH" ]; then
  echo "error: could not resolve DRILL_PATH from @locum/observability" >&2
  exit 2
fi

TARGET_URL="${BASE_URL}${DRILL_PATH}"
echo "==> firing drill at ${TARGET_URL}"

HTTP_STATUS="$(curl -sS -o "$RESPONSE_BODY" -w '%{http_code}' -X POST \
  -H "x-drill-secret: ${DRILL_SECRET}" \
  "$TARGET_URL")"
BODY="$(cat "$RESPONSE_BODY")"

echo "HTTP ${HTTP_STATUS}"
echo "${BODY}"

if [ "$HTTP_STATUS" = "500" ] && printf '%s' "$BODY" | grep -q '"drill_fired"'; then
  echo "==> drill fired as expected — now confirm a human was actually paged (§15: the gate is that a phone buzzes, not that this script exited 0)"
  exit 0
fi

echo "==> drill did NOT fire as expected (wanted HTTP 500 with \"drill_fired\") — see docs/RAILWAY.md / drill.ts's DrillGate for what a 404/401/429 each mean" >&2
exit 1

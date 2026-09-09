#!/usr/bin/env bash
# Prints "<access token> <project id>" for a project slug, so a pipeline can run
# the evaluation CLI as a real caller.
#
# A script rather than a snippet in a workflow because three jobs needed the
# same twenty lines, and the copies had already started to drift: an evaluation
# that authenticated differently from the way the platform is used would be
# measuring something else.
set -euo pipefail

SLUG="${1:-platform-ci}"
BASE_URL="${PLATFORM_BASE_URL:-http://localhost:8080}"
ADMIN_EMAIL="${IDENTITY_BOOTSTRAP_ADMIN_EMAIL:-admin@aia.local}"
ADMIN_PASSWORD="${IDENTITY_BOOTSTRAP_ADMIN_PASSWORD:-change-me-now}"

TOKEN=$(curl -sS -X POST "${BASE_URL}/v1/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"password\",\"username\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

# The suite names a SLUG and the runner needs an id. Resolved here, once, and
# refused loudly when the project is missing: `make seed` creates it, and a
# suite silently pointed at the wrong project would report numbers for traffic
# nobody meant to measure.
PROJECT=$(curl -sS "${BASE_URL}/v1/projects" \
  -H "Authorization: Bearer ${TOKEN}" \
  | SLUG="$SLUG" python3 -c '
import json, os, sys

slug = os.environ["SLUG"]
projects = json.load(sys.stdin).get("items", [])
found = next((p for p in projects if p["slug"] == slug), None)
if found is None:
    sys.exit(f"no project with the slug {slug!r} (tools/scripts/seed.sh creates it)")
print(found["id"])')

printf '%s %s\n' "$TOKEN" "$PROJECT"

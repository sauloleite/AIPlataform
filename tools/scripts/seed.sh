#!/usr/bin/env bash
# Creates a sample project with a budget, so a freshly started environment has
# something to exercise. Idempotent: running it again duplicates nothing.
set -euo pipefail

# Loads .env when it exists, WITHOUT overriding anything already exported: an
# explicit `IDENTITY_BOOTSTRAP_ADMIN_PASSWORD=... bash tools/scripts/...` still
# wins. Without this, changing a value in .env leaves the script on its built-in
# defaults and the failure reads as bad credentials rather than as stale config.
ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|'#'*) continue ;; esac
    if [ -z "${!key:-}" ]; then export "$key=$value"; fi
  done < "$ENV_FILE"
fi

BASE_URL="${PLATFORM_BASE_URL:-http://localhost:8080}"
ADMIN_EMAIL="${IDENTITY_BOOTSTRAP_ADMIN_EMAIL:-admin@aia.local}"
ADMIN_PASSWORD="${IDENTITY_BOOTSTRAP_ADMIN_PASSWORD:-change-me-now}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "Authenticating as ${ADMIN_EMAIL}"
TOKEN=$(curl -sS -X POST "${BASE_URL}/v1/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"password\",\"username\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

say "Creating the sample project"
curl -sS -X POST "${BASE_URL}/v1/projects" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "sample",
    "name": "Sample project",
    "data_classification": "internal",
    "legal_basis": "legitimate interest",
    "purpose": "platform demonstration"
  }' | python3 -m json.tool || echo "(the project already exists)"

PROJECT_ID=$(curl -sS "${BASE_URL}/v1/projects" -H "Authorization: Bearer ${TOKEN}" \
  | python3 -c '
import json,sys
projects = json.load(sys.stdin)["items"]
match = next((p for p in projects if p["slug"] == "sample"), None)
print(match["id"] if match else "")')

say "Setting a budget of BRL 50.00 per month"
curl -sS -X PUT "${BASE_URL}/v1/projects/${PROJECT_ID}/budget" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"limit":{"currency":"BRL","micros":50000000},"period":"monthly"}' \
  | python3 -m json.tool

# Evaluation spends real inference, so it spends it against its OWN budget.
# `evals/suites/platform-runbook.yaml` names this project, and without it
# `make eval` fails on a project that does not exist -- which is part of why
# nothing ever ran it.
say "Creating the platform-ci project, which the evaluation suites run against"
curl -sS -X POST "${BASE_URL}/v1/projects" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "platform-ci",
    "name": "Platform CI",
    "data_classification": "internal",
    "legal_basis": "legitimate interest",
    "purpose": "automated quality evaluation of the platform itself"
  }' | python3 -m json.tool || echo "(the project already exists)"

CI_PROJECT_ID=$(curl -sS "${BASE_URL}/v1/projects" -H "Authorization: Bearer ${TOKEN}" \
  | python3 -c '
import json,sys
projects = json.load(sys.stdin)["items"]
match = next((p for p in projects if p["slug"] == "platform-ci"), None)
print(match["id"] if match else "")')

if [ -n "${CI_PROJECT_ID}" ]; then
  # Smaller than the sample project on purpose: a runaway suite should exhaust
  # its own budget and stop, not the one a person is using.
  curl -sS -X PUT "${BASE_URL}/v1/projects/${CI_PROJECT_ID}/budget" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"limit":{"currency":"BRL","micros":10000000},"period":"monthly"}' \
    >/dev/null
  say "platform-ci has BRL 10.00 per month"
fi

cat <<EOF

Done. Use these values to talk to the platform:

  export AIA_TOKEN='${TOKEN}'
  export AIA_PROJECT='${PROJECT_ID}'

  curl -N -X POST ${BASE_URL}/v1/chat/completions \\
    -H "Authorization: Bearer \$AIA_TOKEN" \\
    -H "X-Project-Id: \$AIA_PROJECT" \\
    -H 'Content-Type: application/json' \\
    -d '{"model":"chat-local","messages":[{"role":"user","content":"hello"}],"stream":true}'

EOF

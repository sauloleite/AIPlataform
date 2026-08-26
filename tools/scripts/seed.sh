#!/usr/bin/env bash
# Cria um projeto de exemplo com orcamento, para dar o que testar em um ambiente
# recem-subido. Idempotente: rodar de novo nao duplica nada.
set -euo pipefail

BASE_URL="${PLATFORM_BASE_URL:-http://localhost:8080}"
ADMIN_EMAIL="${IDENTITY_BOOTSTRAP_ADMIN_EMAIL:-admin@aia.local}"
ADMIN_PASSWORD="${IDENTITY_BOOTSTRAP_ADMIN_PASSWORD:-change-me-now}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "Autenticando como ${ADMIN_EMAIL}"
TOKEN=$(curl -sS -X POST "${BASE_URL}/v1/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"password\",\"username\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

say "Criando projeto de exemplo"
curl -sS -X POST "${BASE_URL}/v1/projects" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "exemplo",
    "name": "Projeto de exemplo",
    "data_classification": "interno",
    "legal_basis": "legitimo interesse",
    "purpose": "demonstracao da plataforma"
  }' | python3 -m json.tool || echo "(projeto ja existe)"

PROJECT_ID=$(curl -sS "${BASE_URL}/v1/projects" -H "Authorization: Bearer ${TOKEN}" \
  | python3 -c '
import json,sys
projects = json.load(sys.stdin)["items"]
match = next((p for p in projects if p["slug"] == "exemplo"), None)
print(match["id"] if match else "")')

say "Definindo orcamento de R$ 50,00 por mes"
curl -sS -X PUT "${BASE_URL}/v1/projects/${PROJECT_ID}/budget" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"limit":{"currency":"BRL","micros":50000000},"period":"monthly"}' \
  | python3 -m json.tool

cat <<EOF

Pronto. Use estes valores para conversar com a plataforma:

  export AIA_TOKEN='${TOKEN}'
  export AIA_PROJECT='${PROJECT_ID}'

  curl -N -X POST ${BASE_URL}/v1/chat/completions \\
    -H "Authorization: Bearer \$AIA_TOKEN" \\
    -H "X-Project-Id: \$AIA_PROJECT" \\
    -H 'Content-Type: application/json' \\
    -d '{"model":"chat-local","messages":[{"role":"user","content":"ola"}],"stream":true}'

EOF

#!/usr/bin/env bash
# Baixa os modelos locais. E o que permite a plataforma responder sem nenhuma
# chave de API paga.
set -euo pipefail

CHAT_MODEL="${OLLAMA_CHAT_MODEL:-llama3.2:1b}"
EMBEDDING_MODEL="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}"
CONTAINER="${OLLAMA_CONTAINER:-aia-ollama-1}"

echo "Baixando modelos no Ollama (pode levar alguns minutos na primeira vez)."
echo "  chat:      ${CHAT_MODEL}"
echo "  embedding: ${EMBEDDING_MODEL}"
echo

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Container ${CONTAINER} nao esta rodando. Rode 'make dev-infra' antes." >&2
  exit 1
fi

docker exec "${CONTAINER}" ollama pull "${CHAT_MODEL}"
docker exec "${CONTAINER}" ollama pull "${EMBEDDING_MODEL}"

echo
echo "Modelos disponiveis:"
docker exec "${CONTAINER}" ollama list

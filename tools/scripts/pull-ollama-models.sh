#!/usr/bin/env bash
# Pulls the local models. This is what lets the platform answer with no paid
# API key at all.
set -euo pipefail

CHAT_MODEL="${OLLAMA_CHAT_MODEL:-llama3.2:1b}"
EMBEDDING_MODEL="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}"
CONTAINER="${OLLAMA_CONTAINER:-aia-ollama-1}"

echo "Pulling models into Ollama (this can take a few minutes the first time)."
echo "  chat:      ${CHAT_MODEL}"
echo "  embedding: ${EMBEDDING_MODEL}"
echo

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Container ${CONTAINER} is not running. Run 'make dev-infra' first." >&2
  exit 1
fi

docker exec "${CONTAINER}" ollama pull "${CHAT_MODEL}"
docker exec "${CONTAINER}" ollama pull "${EMBEDDING_MODEL}"

echo
echo "Models available:"
docker exec "${CONTAINER}" ollama list

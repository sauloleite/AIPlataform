# AIA 2.0 OSS - atalhos padronizados do monorepo (doc 03, secao 2).
# Tudo aqui roda sem nenhuma conta de cloud.

SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(PATH)

COMPOSE := docker compose -f deploy/compose/docker-compose.yml --env-file .env
COMPOSE_PROD := docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.prod.yml --env-file .env

.DEFAULT_GOAL := help
.PHONY: help bootstrap dev dev-infra down clean logs lint lint-fix arch test test-unit test-integration \
        contracts typecheck e2e eval seed models build images helm-lint check

help: ## Lista os alvos disponiveis
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Instala pnpm, uv e todas as dependencias
	@command -v pnpm >/dev/null 2>&1 || { mkdir -p $(HOME)/.local/bin && corepack enable --install-directory $(HOME)/.local/bin; }
	@command -v uv >/dev/null 2>&1 || python3 -m pip install --user --quiet uv
	@test -f .env || { cp .env.example .env && echo "criado .env a partir de .env.example"; }
	pnpm install
	uv sync --all-packages
	@echo ""
	@echo "Pronto. Rode 'make dev' (precisa do Docker em execucao)."

dev-infra: ## Sobe so a infraestrutura (Mongo, Redis, MinIO, Qdrant, LGTM, Ollama)
	$(COMPOSE) up -d mongo redis minio qdrant lgtm ollama
	@echo "infraestrutura de pe. Grafana em http://localhost:3000"

dev: ## Sobe a plataforma inteira em modo desenvolvimento
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  API        http://localhost:8080"
	@echo "  Grafana    http://localhost:3000"
	@echo "  MinIO      http://localhost:9001"
	@echo "  Qdrant     http://localhost:6333/dashboard"

down: ## Derruba os containers
	$(COMPOSE) down

clean: ## Derruba os containers e apaga os volumes (perde os dados locais)
	$(COMPOSE) down -v
	rm -rf node_modules dist .nx coverage .venv

logs: ## Segue os logs (use SERVICE=inference-router para filtrar)
	$(COMPOSE) logs -f $(SERVICE)

models: ## Baixa os modelos locais no Ollama (custo zero, sem chave de API)
	bash tools/scripts/pull-ollama-models.sh

seed: ## Cria usuario, projeto e orcamento de exemplo
	bash tools/scripts/seed.sh

lint: ## Lint e formatacao (falha em warning, doc 03 secao 5)
	pnpm exec prettier --check .
	pnpm exec eslint . --max-warnings 0
	uv run ruff check .
	uv run ruff format --check .

lint-fix: ## Corrige o que for automatico
	pnpm exec prettier --write .
	pnpm exec eslint . --fix
	uv run ruff check --fix .
	uv run ruff format .

typecheck: ## Verificacao de tipos nos dois ecossistemas
	pnpm exec tsc --build tsconfig.build.json --pretty
	uv run mypy .

arch: ## Regra de dependencia da Clean Architecture (falha o build)
	pnpm exec depcruise --config .dependency-cruiser.cjs --output-type err apps packages
	uv run lint-imports

test-unit: ## Testes unitarios (dominio e aplicacao, sem I/O)
	pnpm exec vitest run --project unit
	uv run pytest -m "not integration and not contract"

test-integration: ## Testes de integracao (exige Docker)
	pnpm exec vitest run --project integration
	uv run pytest -m integration

test: test-unit test-integration ## Toda a suite de testes

contracts: ## Regera tipos a partir de contracts/openapi e contracts/asyncapi
	node tools/scripts/generate-contracts.mjs

e2e: ## Fluxo 7.1 ponta a ponta contra o ambiente local
	bash tools/scripts/e2e.sh

eval: ## Suites de avaliacao com gate por limiar
	uv run python -m evaluation.cli run --suite evals/suites

build: ## Compila os pacotes e servicos TypeScript
	pnpm exec nx run-many -t build --all

images: ## Constroi as imagens de container
	$(COMPOSE) build

helm-lint: ## Valida o chart Helm
	helm lint deploy/helm/aia-platform
	helm template aia deploy/helm/aia-platform >/dev/null && echo "helm template OK"

check: lint typecheck arch test ## O que o CI roda em toda PR

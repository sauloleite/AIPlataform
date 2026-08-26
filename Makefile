# AIA 2.0 OSS - the monorepo standard shortcuts (reference doc 03 §2).
# Everything here runs with no cloud account at all.

SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(PATH)

COMPOSE := docker compose -f deploy/compose/docker-compose.yml --env-file .env
COMPOSE_PROD := docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.prod.yml --env-file .env

.DEFAULT_GOAL := help
.PHONY: help bootstrap dev dev-infra down clean logs lint lint-fix arch test test-unit test-integration \
        contracts typecheck e2e eval seed models build images helm-lint check

help: ## Lists the available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Installs pnpm, uv and every dependency
	@command -v pnpm >/dev/null 2>&1 || { mkdir -p $(HOME)/.local/bin && corepack enable --install-directory $(HOME)/.local/bin; }
	@command -v uv >/dev/null 2>&1 || python3 -m pip install --user --quiet uv
	@test -f .env || { cp .env.example .env && echo "created .env from .env.example"; }
	pnpm install
	uv sync --all-packages
	@echo ""
	@echo "Done. Run 'make dev' (Docker has to be running)."

dev-infra: ## Brings up the infrastructure only (Mongo, Redis, MinIO, Qdrant, LGTM, Ollama)
	$(COMPOSE) up -d mongo redis minio qdrant lgtm ollama
	@echo "infrastructure up. Grafana at http://localhost:3000"

dev: ## Brings the whole platform up in development mode
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  Console    http://localhost:8080"
	@echo "  API        http://localhost:8080/v1"
	@echo "  Grafana    http://localhost:3000"
	@echo "  MinIO      http://localhost:9001"
	@echo "  Qdrant     http://localhost:6333/dashboard"

down: ## Stops the containers
	$(COMPOSE) down

clean: ## Stops the containers and deletes the volumes (loses the local data)
	$(COMPOSE) down -v
	rm -rf node_modules dist .nx coverage .venv

logs: ## Follows the logs (use SERVICE=inference-router to filter)
	$(COMPOSE) logs -f $(SERVICE)

models: ## Pulls the local models into Ollama (zero cost, no API key)
	bash tools/scripts/pull-ollama-models.sh

seed: ## Creates a sample user, project and budget
	bash tools/scripts/seed.sh

lint: ## Lint and formatting (fails on a warning, reference doc 03 §5)
	pnpm exec prettier --check .
	pnpm exec eslint . --max-warnings 0
	uv run ruff check .
	uv run ruff format --check .

lint-fix: ## Fixes what can be fixed automatically
	pnpm exec prettier --write .
	pnpm exec eslint . --fix
	uv run ruff check --fix .
	uv run ruff format .

typecheck: ## Type checking in both ecosystems
	pnpm exec tsc --build tsconfig.build.json --pretty
	pnpm exec nx run-many -t typecheck --all
	uv run mypy .

arch: ## The Clean Architecture dependency rule (fails the build)
	pnpm exec depcruise --config .dependency-cruiser.cjs --output-type err apps packages
	uv run lint-imports

test-unit: ## Unit tests (domain and application, no I/O)
	pnpm exec vitest run --project unit
	uv run pytest -m "not integration and not contract"

test-integration: ## Integration tests (Docker required)
	pnpm exec vitest run --project integration
	uv run pytest -m integration

test: test-unit test-integration ## The whole test suite

contracts: ## Regenerates the types from contracts/openapi and contracts/asyncapi
	node tools/scripts/generate-contracts.mjs

e2e: ## Flow 7.1 end to end against the local environment
	bash tools/scripts/e2e.sh

eval: ## Evaluation suites, gated by threshold
	uv run python -m evaluation.cli run --suite evals/suites

build: ## Compiles the TypeScript packages and services
	pnpm exec nx run-many -t build --all

images: ## Builds the container images
	$(COMPOSE) build

helm-lint: ## Validates the Helm chart
	helm lint deploy/helm/aia-platform
	helm template aia deploy/helm/aia-platform >/dev/null && echo "helm template OK"

check: lint typecheck arch test ## What CI runs on every PR

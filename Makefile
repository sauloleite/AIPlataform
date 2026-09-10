# AIA 2.0 OSS - the monorepo standard shortcuts (reference doc 03 §2).
# Everything here runs with no cloud account at all.

SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(PATH)

COMPOSE := docker compose -f deploy/compose/docker-compose.yml --env-file .env
COMPOSE_PROD := docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.prod.yml --env-file .env

.DEFAULT_GOAL := help
.PHONY: help bootstrap dev dev-infra down clean logs lint lint-fix arch test test-unit test-integration \
        contracts routes typecheck e2e eval calibrate seed models build images helm-lint check

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

seed: ## Creates the admin, a sample project and the platform-ci eval project
	bash tools/scripts/seed.sh

# ESLint runs the type-aware rules over the whole monorepo, which means holding
# the TypeScript program for eleven services and nine packages in one heap.
# Node's default ceiling here is about 2 GB and the run now needs more than
# that: it dies with "Reached heap limit", which reads like a lint failure and
# is not one. The number is a ceiling, not a reservation.
LINT_HEAP_MB ?= 6144

lint: ## Lint and formatting (fails on a warning, reference doc 03 §5)
	pnpm exec prettier --check .
	NODE_OPTIONS=--max-old-space-size=$(LINT_HEAP_MB) pnpm exec eslint . --max-warnings 0
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
	node tools/scripts/check-project-references.mjs
	node tools/scripts/check-dashboards.mjs

# `--project unit` used to be here and matched nothing: there is no vitest
# projects config, each package owns its own vitest.config.ts. `nx run-many` is
# what CI actually runs, so this target now runs the same thing -- a `make check`
# that fails on its own tooling teaches people to stop running it.
test-unit: ## Unit tests (domain and application, no I/O)
	pnpm exec nx run-many -t test --all
	uv run pytest -m "not integration and not contract"

# Both ecosystems, because CI runs both. This target used to run only pytest
# while CI's job of the same name ran only vitest, so an integration test in
# either language could be written into a runner that never executed it.
#
# Exit code 5 is pytest's "nothing collected". There are no Python integration
# tests yet, and that is not a failure -- it becomes one the day somebody writes
# one and it breaks.
test-integration: ## Integration tests (Docker required)
	RUN_INTEGRATION=1 pnpm exec vitest run --dir apps --passWithNoTests
	uv run pytest -m integration || [ $$? -eq 5 ]

test: test-unit test-integration ## The whole test suite

contracts: ## Regenerates the types from contracts/openapi and contracts/asyncapi
	node tools/scripts/generate-contracts.mjs

routes: ## Every registered route is declared in a contract, and the reverse
	uv run python tools/scripts/check_routes.py

e2e: ## Flows 7.1, 7.2 and 7.3 end to end against the local environment
	bash tools/scripts/e2e.sh

# `SUITE` takes a file or a directory, so a runbook can gate on ONE suite before
# an alias swap rather than running every judged case to answer one question.
SUITE ?= evals/suites

eval: ## Evaluation suites, gated by threshold. Override with SUITE=path
	uv run python -m evaluation.cli run --suite $(SUITE)

LABELS ?= evals/labels

# A judged suite refuses to run until its judge has been measured against these
# labels (ADR-028). This is what produces that record; it costs one inference
# per label, so it is run when the judge alias changes, not on every push.
calibrate: ## Measures the judge against evals/labels and writes the record
	uv run python -m evaluation.cli calibrate --labels $(LABELS)

build: ## Compiles the TypeScript packages and services
	pnpm exec nx run-many -t build --all

images: ## Builds the container images
	$(COMPOSE) build

helm-lint: ## Validates the Helm chart
	helm lint deploy/helm/aia-platform
	helm template aia deploy/helm/aia-platform >/dev/null && echo "helm template OK"

# Everything CI can run without Docker, a cluster or a network. The jobs left
# out are left out because they need something this cannot assume: `e2e` needs
# the platform up, `helm` needs helm, `delivery` and `contracts` need nothing
# but are cheap enough that CI is the right place for them alone.
#
# It said "what CI runs on every PR" while omitting five jobs, which is the kind
# of claim that makes somebody trust a green local run and get a red PR.
check: lint typecheck arch routes test ## Everything CI runs that needs no Docker

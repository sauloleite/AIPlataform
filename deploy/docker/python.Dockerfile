# syntax=docker/dockerfile:1.7
# Image for the FastAPI services.
#
#   docker build -f deploy/docker/python.Dockerfile --build-arg SERVICE=guardrails .

ARG PYTHON_VERSION=3.12-slim-bookworm

# ----------------------------------------------------------------------------
FROM python:${PYTHON_VERSION} AS build
ARG SERVICE
ARG WITH_SPACY_MODEL=false
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.5.14 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

COPY pyproject.toml uv.lock ./
COPY python/ python/
COPY apps/${SERVICE}/ apps/${SERVICE}/

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package "${SERVICE}"

# The spaCy model weighs ~15 MB and only guardrails needs it. Without it, the
# detector falls back to regex, which still covers CPF, CNPJ and card.
RUN if [ "${WITH_SPACY_MODEL}" = "true" ]; then \
      uv run python -m spacy download pt_core_news_sm && \
      uv run python -m spacy download en_core_web_sm; \
    fi

# ----------------------------------------------------------------------------
FROM python:${PYTHON_VERSION} AS runtime
ARG SERVICE
WORKDIR /app

RUN groupadd --system --gid 1001 aia && \
    useradd --system --uid 1001 --gid aia --create-home aia

COPY --from=build --chown=aia:aia /app/.venv /app/.venv
COPY --from=build --chown=aia:aia /app/python /app/python
COPY --from=build --chown=aia:aia /app/apps/${SERVICE} /app/apps/${SERVICE}

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SERVICE_MODULE=${SERVICE}

USER aia
EXPOSE 8000

# `sh -c` because the module comes from a variable; the package name swaps `-` for `_`.
CMD ["sh", "-c", "uvicorn $(echo $SERVICE_MODULE | tr '-' '_').main:app --host 0.0.0.0 --port ${PORT:-8000}"]

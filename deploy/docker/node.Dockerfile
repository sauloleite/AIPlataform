# syntax=docker/dockerfile:1.7
# Image for the TypeScript services. Multi-stage and distroless: the final image
# has neither a shell nor a package manager, so an RCE finds no tooling.
#
#   docker build -f deploy/docker/node.Dockerfile --build-arg SERVICE=inference-router .

ARG NODE_VERSION=22.19-bookworm-slim

# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

RUN corepack enable

# Manifests only, first: the dependency layer is invalidated when a package.json
# changes, not on every code change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/auth/package.json          packages/auth/
COPY packages/contracts/package.json     packages/contracts/
COPY packages/errors/package.json        packages/errors/
COPY packages/messaging/package.json     packages/messaging/
COPY packages/nest/package.json          packages/nest/
COPY packages/resilience/package.json    packages/resilience/
COPY packages/sdk/package.json           packages/sdk/
COPY packages/telemetry/package.json     packages/telemetry/
COPY apps/governance/package.json        apps/governance/
COPY apps/identity/package.json          apps/identity/
COPY apps/inference-router/package.json  apps/inference-router/
COPY apps/registry/package.json          apps/registry/
COPY apps/knowledge/package.json         apps/knowledge/
COPY apps/mcp-gateway/package.json       apps/mcp-gateway/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ----------------------------------------------------------------------------
FROM deps AS build
ARG SERVICE
WORKDIR /app

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/${SERVICE}/ apps/${SERVICE}/

# `tsconfig.build.json`, not `tsconfig.json`: the build one excludes tests and
# config files, which must not go into the image.
RUN pnpm exec tsc --build apps/${SERVICE}/tsconfig.build.json

# `--prod` drops devDependencies; `deploy` flattens the workspace links into a
# self-contained tree, which is what the distroless image can load.
RUN pnpm --filter "@aia/${SERVICE}" deploy --prod --legacy /output

# ----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
ARG SERVICE
WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"

COPY --from=build --chown=nonroot:nonroot /output/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /output/dist ./dist
COPY --from=build --chown=nonroot:nonroot /app/packages ./packages

USER nonroot
EXPOSE 3000

# No shell in the image: the compose healthcheck uses Node itself.
CMD ["dist/main.js"]

# syntax=docker/dockerfile:1.7
# Image for the console (Next.js).
#
# Separate from node.Dockerfile because Next builds itself: there is no
# `tsc --build` step and no `pnpm deploy`. Its standalone output already traces
# the files it needs and copies them, so what ships is a self-contained server
# with no workspace symlinks.
#
#   docker build -f deploy/docker/web.Dockerfile .

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
COPY apps/web/package.json               apps/web/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/

# The console imports the generated contract types, so the packages have to be
# compiled before Next resolves them.
RUN pnpm exec tsc --build packages/contracts/tsconfig.build.json

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @aia/web run build

# ----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3005
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# The standalone bundle plus the static assets, which Next deliberately leaves
# out of it so a CDN can serve them instead.
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/static ./apps/web/.next/static

USER nonroot
EXPOSE 3005

# No shell in the image: the compose healthcheck uses Node itself.
CMD ["apps/web/server.js"]

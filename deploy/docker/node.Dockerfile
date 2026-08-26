# syntax=docker/dockerfile:1.7
# Imagem dos servicos TypeScript. Multi-stage e distroless: a imagem final nao
# tem shell nem gerenciador de pacotes, entao um RCE nao encontra ferramenta.
#
#   docker build -f deploy/docker/node.Dockerfile --build-arg SERVICE=inference-router .

ARG NODE_VERSION=22.19-bookworm-slim

# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

RUN corepack enable

# So os manifestos primeiro: a camada de dependencias so invalida quando um
# package.json muda, e nao a cada alteracao de codigo.
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

# `tsconfig.build.json`, e nao `tsconfig.json`: o de build exclui testes e
# arquivos de configuracao, que nao devem ir para a imagem.
RUN pnpm exec tsc --build apps/${SERVICE}/tsconfig.build.json

# `--prod` remove devDependencies; `deploy` achata os links do workspace em uma
# arvore autocontida, que e o que a imagem distroless consegue carregar.
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

# Sem shell na imagem: o healthcheck do compose usa o proprio Node.
CMD ["dist/main.js"]

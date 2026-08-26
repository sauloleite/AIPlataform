#!/usr/bin/env node
/**
 * Gerador de servico.
 *
 * Produz o esqueleto das secoes 3.2 (NestJS) e 3.3 (FastAPI) do documento 03,
 * ja com camadas, ports, configuracao validada, health checks, Dockerfile e
 * entrada no CI.
 *
 * Existe porque a alternativa e copiar um servico existente e esquecer de trocar
 * alguma coisa. O esqueleto correto por construcao e o que faz a regra de
 * dependencia continuar valendo no decimo servico.
 *
 *   node tools/generators/new-service.mjs --name registry --runtime node --port 3004
 *   node tools/generators/new-service.mjs --name evaluation --runtime python --port 8003
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key !== undefined) args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const name = args['name'];
const runtime = args['runtime'] ?? 'node';
const port = args['port'] ?? (runtime === 'node' ? '3010' : '8010');
const moduleName = args['module'] ?? 'core';

if (name === undefined || !/^[a-z][a-z0-9-]{2,40}$/.test(name)) {
  console.error('Uso: --name <servico-em-kebab-case> [--runtime node|python] [--port N]');
  process.exit(1);
}
if (!['node', 'python'].includes(runtime)) {
  console.error(`runtime invalido: ${runtime}. Use "node" ou "python".`);
  process.exit(1);
}

const appDir = join(root, 'apps', name);
if (existsSync(join(appDir, 'src'))) {
  console.error(`apps/${name}/src ja existe. Remova antes de gerar de novo.`);
  process.exit(1);
}

const pascal = name.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
const snake = name.replace(/-/g, '_');

async function write(relativePath, content) {
  const target = join(appDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  console.log(`  ${join('apps', name, relativePath)}`);
}

/* ------------------------------------------------------------------ */
/* NestJS                                                              */
/* ------------------------------------------------------------------ */

async function generateNode() {
  await write(
    'package.json',
    `${JSON.stringify(
      {
        name: `@aia/${name}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        main: 'dist/main.js',
        scripts: {
          build: 'tsc --build',
          start: 'node dist/main.js',
          dev: 'tsx watch src/main.ts',
          typecheck: 'tsc --noEmit -p tsconfig.json',
          test: 'vitest run',
          lint: 'eslint src --max-warnings 0',
        },
        dependencies: {
          '@aia/auth': 'workspace:*',
          '@aia/contracts': 'workspace:*',
          '@aia/errors': 'workspace:*',
          '@aia/messaging': 'workspace:*',
          '@aia/nest': 'workspace:*',
          '@aia/resilience': 'workspace:*',
          '@aia/telemetry': 'workspace:*',
          '@nestjs/common': '^11.0.5',
          '@nestjs/core': '^11.0.5',
          '@nestjs/platform-express': '^11.0.5',
          ioredis: '^5.4.2',
          mongodb: '^6.12.0',
          'reflect-metadata': '^0.2.2',
          rxjs: '^7.8.1',
          zod: '^3.24.1',
        },
        devDependencies: { '@types/express': '^5.0.0' },
      },
      null,
      2,
    )}\n`,
  );

  await write(
    'tsconfig.json',
    `${JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          rootDir: 'src',
          outDir: 'dist',
          tsBuildInfoFile: 'dist/.tsbuildinfo',
        },
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.spec.ts', 'test/**/*'],
        references: [
          '../../packages/auth',
          '../../packages/contracts',
          '../../packages/errors',
          '../../packages/messaging',
          '../../packages/nest',
          '../../packages/resilience',
          '../../packages/telemetry',
        ].map((path) => ({ path })),
      },
      null,
      2,
    )}\n`,
  );

  await write(
    'vitest.config.ts',
    `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/domain/**', 'src/**/application/**'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
`,
  );

  await write(
    'src/config/index.ts',
    `import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/** Configuracao validada no boot. A aplicacao nao sobe com config invalida. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(${port}),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DATABASE: z.string().default('aia_${snake}'),
  REDIS_URL: z.string().min(1),

  IDENTITY_ISSUER: z.string().url(),
  IDENTITY_AUDIENCE: z.string().default('aia-platform'),
  IDENTITY_JWKS_URL: z.string().url().optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type ${pascal}Config = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ${pascal}Config {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('${pascal}Config');
`,
  );

  await write(`src/modules/${moduleName}/domain/entities/.gitkeep`, '');
  await write(`src/modules/${moduleName}/domain/value-objects/.gitkeep`, '');
  await write(`src/modules/${moduleName}/domain/services/.gitkeep`, '');

  await write(
    `src/modules/${moduleName}/domain/errors/index.ts`,
    `import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

/**
 * Erros de dominio deste servico.
 *
 * Cada um carrega um codigo ESTAVEL do catalogo: e por ele que o cliente decide
 * comportamento, entao mudar o valor e breaking change.
 */
export class ExemploError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(detalhe: string) {
    super(detalhe);
  }
}
`,
  );

  await write(
    `src/modules/${moduleName}/application/ports.ts`,
    `/**
 * Ports da camada de aplicacao.
 *
 * Interfaces, nunca classes concretas: o caso de uso nao sabe o que ha do outro
 * lado. Os Symbol existem porque o NestJS precisa de um token em runtime, e
 * interface some na compilacao.
 */

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');
`,
  );

  await write(
    `src/modules/${moduleName}/application/dto.ts`,
    `/** Comandos e resultados. Sem \`Request\`, sem header, sem decorator de HTTP. */

export interface ExemploCommand {
  projectId: string;
}

export interface ExemploResult {
  id: string;
}
`,
  );

  await write(
    `src/modules/${moduleName}/application/use-cases/exemplo.ts`,
    `import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../ports.js';
import type { ExemploCommand, ExemploResult } from '../dto.js';

/**
 * Caso de uso de exemplo. Troque por um real e apague este.
 *
 * Regras do template (doc 03, secao 3.2):
 *   - recebe um comando, nunca o \`Request\` do Express;
 *   - fala so com ports;
 *   - todo caminho de erro tem teste.
 */
@Injectable()
export class Exemplo {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ExemploCommand): Promise<ExemploResult> {
    void command;
    void this.clock;
    return Promise.resolve({ id: this.ids.next() });
  }
}
`,
  );

  await write(`src/modules/${moduleName}/infrastructure/.gitkeep`, '');

  await write(
    `src/modules/${moduleName}/presentation/http/${moduleName}.controller.ts`,
    `import { Controller, Get, Req } from '@nestjs/common';
import { POLICY, authorize } from '@aia/auth';
import { principalOf, projectIdOf, type AuthenticatedRequest } from '@aia/nest';
import { Exemplo } from '../../application/use-cases/exemplo.js';

/** Adapta HTTP para os casos de uso. Nenhuma regra de negocio aqui. */
@Controller('v1/${name}')
export class ${pascal}Controller {
  constructor(private readonly exemplo: Exemplo) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ id: string }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return this.exemplo.execute({ projectId });
  }
}
`,
  );

  await write(
    `src/modules/${moduleName}/${moduleName}.module.ts`,
    `import { randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { Db } from 'mongodb';
import { Redis } from 'ioredis';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';
import { Exemplo } from './application/use-cases/exemplo.js';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from './application/ports.js';
import { ${pascal}Controller } from './presentation/http/${moduleName}.controller.js';

/** Wiring: o unico lugar que conhece as tres camadas ao mesmo tempo. */
const adapters: Provider[] = [
  { provide: CLOCK, useValue: { now: (): Date => new Date() } satisfies Clock },
  { provide: ID_GENERATOR, useValue: { next: (): string => randomUUID() } satisfies IdGenerator },
  {
    provide: HEALTH_CHECKS,
    useFactory: (db: Db, redis: Redis): DependencyCheck[] => [
      {
        name: 'mongodb',
        critical: true,
        check: async () => {
          await db.command({ ping: 1 });
          return { status: 'ok' as const };
        },
      },
      {
        name: 'redis',
        critical: false,
        check: async () => {
          await redis.ping();
          return { status: 'ok' as const };
        },
      },
    ],
    inject: [Db, Redis],
  },
];

@Module({
  controllers: [${pascal}Controller, HealthController],
  providers: [Exemplo, ...adapters],
})
export class ${pascal}Module {}
`,
  );

  const infra = await readFile(
    join(root, 'apps/governance/src/shared/infrastructure.module.ts'),
    'utf8',
  );
  await write(
    'src/shared/infrastructure.module.ts',
    infra
      .replace(/GovernanceConfig/g, `${pascal}Config`)
      .replace(/'\.\.\/config\/index\.js'/g, "'../config/index.js'"),
  );

  await write(
    'src/app.module.ts',
    `import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, RequestContextMiddleware } from '@aia/nest';
import { ${pascal}Module } from './modules/${moduleName}/${moduleName}.module.js';
import { InfrastructureModule } from './shared/infrastructure.module.js';

@Module({
  imports: [InfrastructureModule, ${pascal}Module],
  // Guard global: a rota precisa se declarar publica para escapar dele.
  // Esquecer o decorator falha fechado.
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
`,
  );

  await write(
    'src/main.ts',
    `import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';

// A telemetria sobe ANTES de qualquer import que faca I/O: a auto-instrumentacao
// precisa envolver os modulos no momento da carga.
startTelemetry({ serviceName: 'aia-${name}' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger: config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

await app.listen(config.PORT, '0.0.0.0');
logger.log(\`aia-${name} ouvindo na porta \${config.PORT.toString()}\`);
`,
  );

  await write(
    'test/exemplo.spec.ts',
    `import { describe, expect, it } from 'vitest';
import { Exemplo } from '../src/modules/${moduleName}/application/use-cases/exemplo.js';

/**
 * Fakes, nao mocks: o teste verifica COMPORTAMENTO, e nao a sequencia de
 * chamadas. Um teste amarrado a mocks quebra em toda refatoracao sem indicar
 * nenhum defeito real.
 */
describe('Exemplo', () => {
  it('devolve um identificador', async () => {
    const useCase = new Exemplo(
      { now: () => new Date('2026-01-01T00:00:00Z') },
      { next: () => 'id-1' },
    );

    await expect(useCase.execute({ projectId: 'proj-1' })).resolves.toEqual({ id: 'id-1' });
  });
});
`,
  );
}

/* ------------------------------------------------------------------ */
/* FastAPI                                                             */
/* ------------------------------------------------------------------ */

async function generatePython() {
  await write(
    'pyproject.toml',
    `[project]
name = "${name}"
version = "0.1.0"
description = "Servico ${name} da plataforma AIA"
requires-python = ">=3.12"
dependencies = [
    "aia-auth",
    "aia-errors",
    "aia-messaging",
    "aia-resilience",
    "aia-telemetry",
    "fastapi>=0.115.6",
    "uvicorn[standard]>=0.34.0",
    "pydantic>=2.10.5",
    "pydantic-settings>=2.7.1",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/${snake}"]
`,
  );

  await write(`src/${snake}/py.typed`, '');
  await write(
    `src/${snake}/__init__.py`,
    `"""Servico ${name} da plataforma AIA."""

__all__: list[str] = []
`,
  );

  await write(
    `src/${snake}/domain/__init__.py`,
    `"""Dominio do servico.

Regras puras: nada de FastAPI, nada de banco, nada de I/O. E o que permite testar
a regra de negocio sem subir nada.
"""

__all__: list[str] = []
`,
  );

  await write(
    `src/${snake}/domain/entities.py`,
    `"""Entidades e value objects. Dataclasses puras."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Exemplo:
    """Value object de exemplo. Troque por um real e apague este."""

    id: str
    project_id: str

    def __post_init__(self) -> None:
        if not self.project_id:
            msg = "project_id e obrigatorio: projeto e o tenant da plataforma"
            raise ValueError(msg)
`,
  );

  await write(
    `src/${snake}/domain/errors.py`,
    `"""Erros de dominio deste servico."""

from __future__ import annotations

from aia_errors import DomainError, ErrorCode


class ExemploError(DomainError):
    def __init__(self, detalhe: str) -> None:
        super().__init__(detalhe, code=ErrorCode.VALIDATION_FAILED, status=400)
`,
  );

  await write(`src/${snake}/application/__init__.py`, '');
  await write(
    `src/${snake}/application/ports.py`,
    `"""Ports como Protocol.

Adapters nao herdam: so cumprem a assinatura, e o mypy verifica (duck typing).
"""

from __future__ import annotations

from typing import Protocol

from ${snake}.domain.entities import Exemplo


class ExemploRepository(Protocol):
    async def find(self, exemplo_id: str) -> Exemplo | None: ...
    async def save(self, exemplo: Exemplo) -> None: ...
`,
  );

  await write(
    `src/${snake}/application/dto.py`,
    `"""Comandos e resultados. Sem detalhe de HTTP."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExemploCommand:
    project_id: str
`,
  );

  await write(`src/${snake}/application/use_cases/__init__.py`, '');
  await write(
    `src/${snake}/application/use_cases/exemplo.py`,
    `"""Caso de uso de exemplo. Troque por um real e apague este."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from ${snake}.application.dto import ExemploCommand
from ${snake}.application.ports import ExemploRepository
from ${snake}.domain.entities import Exemplo


@dataclass(slots=True)
class ExecutarExemplo:
    repository: ExemploRepository

    async def execute(self, command: ExemploCommand) -> Exemplo:
        exemplo = Exemplo(id=str(uuid.uuid4()), project_id=command.project_id)
        await self.repository.save(exemplo)
        return exemplo
`,
  );

  await write(`src/${snake}/infrastructure/__init__.py`, '');
  await write(
    `src/${snake}/infrastructure/in_memory.py`,
    `"""Adapters em memoria. Substitua por MongoDB quando houver estado real."""

from __future__ import annotations

from dataclasses import dataclass, field

from ${snake}.domain.entities import Exemplo


@dataclass(slots=True)
class InMemoryExemploRepository:
    _items: dict[str, Exemplo] = field(default_factory=dict)

    async def find(self, exemplo_id: str) -> Exemplo | None:
        return self._items.get(exemplo_id)

    async def save(self, exemplo: Exemplo) -> None:
        self._items[exemplo.id] = exemplo
`,
  );

  await write(
    `src/${snake}/config.py`,
    `"""Configuracao validada na inicializacao. 12-factor."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    node_env: str = "development"
    port: int = ${port}
    log_level: str = "info"

    identity_issuer: str = "http://identity:3001"
    identity_audience: str = "aia-platform"
    identity_jwks_url: str | None = None

    otel_exporter_otlp_endpoint: str | None = None

    @property
    def jwks_url(self) -> str:
        return self.identity_jwks_url or f"{self.identity_issuer}/.well-known/jwks.json"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
`,
  );

  await write(
    `src/${snake}/container.py`,
    `"""Composicao de dependencias. Nunca dentro de um caso de uso."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from aia_auth import JwtVerifier

from ${snake}.application.use_cases.exemplo import ExecutarExemplo
from ${snake}.config import Settings, get_settings
from ${snake}.infrastructure.in_memory import InMemoryExemploRepository


@dataclass(slots=True)
class Container:
    settings: Settings
    exemplo: ExecutarExemplo
    verifier: JwtVerifier


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()
    return Container(
        settings=settings,
        exemplo=ExecutarExemplo(repository=InMemoryExemploRepository()),
        verifier=JwtVerifier(
            issuer=settings.identity_issuer,
            jwks_uri=settings.jwks_url,
            audience=settings.identity_audience,
        ),
    )
`,
  );

  await write(`src/${snake}/presentation/__init__.py`, '');
  await write(`src/${snake}/presentation/http/__init__.py`, '');
  await write(
    `src/${snake}/presentation/http/routes.py`,
    `"""Routers FastAPI. So adaptam entrada e saida."""

from __future__ import annotations

from typing import Annotated

from aia_auth import Principal, bearer_token, require_membership
from aia_errors import ProjectRequiredError
from aia_telemetry import AiaAttr, annotate_active_span
from fastapi import APIRouter, Depends, Header

from ${snake}.application.dto import ExemploCommand
from ${snake}.container import get_container

router = APIRouter(prefix="/v1/${name}", tags=["${name}"])
health_router = APIRouter(prefix="/health", tags=["health"])


def _authenticate(
    authorization: Annotated[str | None, Header()] = None,
    x_project_id: Annotated[str | None, Header()] = None,
) -> tuple[Principal, str]:
    """\`Depends\` so existe na apresentacao (doc 03, secao 3.3)."""
    principal = get_container().verifier.verify(bearer_token(authorization))
    if not x_project_id:
        raise ProjectRequiredError()
    if principal.type != "service":
        require_membership(principal, x_project_id)

    annotate_active_span(
        **{AiaAttr.PROJECT_ID: x_project_id, AiaAttr.PRINCIPAL_ID: principal.id}
    )
    return principal, x_project_id


Authenticated = Annotated[tuple[Principal, str], Depends(_authenticate)]


@router.get("")
async def listar(auth: Authenticated) -> dict[str, str]:
    _, project_id = auth
    exemplo = await get_container().exemplo.execute(ExemploCommand(project_id=project_id))
    return {"id": exemplo.id, "project_id": exemplo.project_id}


@health_router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@health_router.get("/ready")
def ready() -> dict[str, str]:
    return {"status": "ok"}
`,
  );

  await write(
    `src/${snake}/main.py`,
    `"""Aplicacao FastAPI do aia-${name}."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from aia_errors import PROBLEM_CONTENT_TYPE, DomainError, problem_from_unknown
from aia_telemetry import current_trace_id, start_telemetry
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ${snake}.config import get_settings
from ${snake}.presentation.http.routes import health_router, router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    _ = app
    settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())
    start_telemetry("aia-${name}")
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="AIA ${pascal}", version="1.0.0", lifespan=lifespan)

    @app.exception_handler(DomainError)
    async def handle_domain_error(request: Request, error: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status,
            content=error.to_problem(instance=request.url.path, trace_id=current_trace_id()),
            media_type=PROBLEM_CONTENT_TYPE,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, error: Exception) -> JSONResponse:
        # Stack no log, correlacionado pelo trace_id; nunca na resposta.
        logger.exception("requisicao falhou em %s", request.url.path)
        problem = problem_from_unknown(
            error, instance=request.url.path, trace_id=current_trace_id()
        )
        return JSONResponse(
            status_code=problem["status"], content=problem, media_type=PROBLEM_CONTENT_TYPE
        )

    app.include_router(router)
    app.include_router(health_router)
    return app


app = create_app()
`,
  );

  await write(
    'tests/test_exemplo.py',
    `"""Teste do caso de uso de exemplo."""

from __future__ import annotations

from ${snake}.application.dto import ExemploCommand
from ${snake}.application.use_cases.exemplo import ExecutarExemplo
from ${snake}.infrastructure.in_memory import InMemoryExemploRepository


async def test_cria_e_persiste() -> None:
    repository = InMemoryExemploRepository()
    resultado = await ExecutarExemplo(repository=repository).execute(
        ExemploCommand(project_id="proj-1")
    )

    assert resultado.project_id == "proj-1"
    assert await repository.find(resultado.id) == resultado
`,
  );
}

/* ------------------------------------------------------------------ */

console.log(`Gerando apps/${name} (${runtime}, porta ${port}):\n`);
await (runtime === 'node' ? generateNode() : generatePython());

const proximosPassos =
  runtime === 'node'
    ? `  1. Adicione "apps/${name}" a pnpm-workspace.yaml
  2. Adicione { "path": "./apps/${name}" } a tsconfig.json (referencias)
  3. pnpm install && pnpm exec tsc --build`
    : `  1. O uv workspace ja inclui apps/* — rode: uv sync --all-packages
  2. Adicione os contratos de camada ao .importlinter (root_packages e layers)`;

console.log(`
Servico apps/${name} criado.

Proximos passos:
${proximosPassos}
  4. Adicione o servico a deploy/compose/docker-compose.yml
  5. Adicione ao chart em deploy/helm/aia-platform/values.yaml e services.yaml
  6. Escreva o contrato em contracts/openapi/${name}.v1.yaml
  7. Troque o "Exemplo" por um caso de uso real e apague o esqueleto

A regra de dependencia ja vale: 'make arch' reprova se domain/ importar de
infrastructure/.
`);

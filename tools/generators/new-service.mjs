#!/usr/bin/env node
/**
 * Service generator.
 *
 * Produces the skeleton from reference doc 03 §3.2 (NestJS) and §3.3 (FastAPI),
 * already carrying layers, ports, validated configuration, health checks, a
 * Dockerfile and a CI entry.
 *
 * It exists because the alternative is copying an existing service and
 * forgetting to change something. A skeleton that is correct by construction is
 * what keeps the dependency rule holding at the tenth service.
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
  console.error('Usage: --name <service-in-kebab-case> [--runtime node|python] [--port N]');
  process.exit(1);
}
if (!['node', 'python'].includes(runtime)) {
  console.error(`invalid runtime: ${runtime}. Use "node" or "python".`);
  process.exit(1);
}

const appDir = join(root, 'apps', name);
if (existsSync(join(appDir, 'src'))) {
  console.error(`apps/${name}/src already exists. Remove it before generating again.`);
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

  // Two configs, like the rest of the monorepo: `tsconfig.build.json` emits and
  // keeps tests out of the image; `tsconfig.json` emits nothing and INCLUDES the
  // tests, which is what makes `nx run-many -t typecheck` cover a test file.
  // The references point at each package's BUILD config: the lint one carries
  // `composite: false`, and `tsc --build` refuses a reference like that.
  await write(
    'tsconfig.build.json',
    `${JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          rootDir: 'src',
          outDir: 'dist',
          tsBuildInfoFile: 'dist/.tsbuildinfo',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
        include: ['src/**/*.ts'],
        exclude: ['node_modules', 'dist', 'src/**/*.spec.ts', 'src/**/*.test.ts', 'test/**/*'],
        references: [
          '../../packages/auth',
          '../../packages/contracts',
          '../../packages/errors',
          '../../packages/messaging',
          '../../packages/nest',
          '../../packages/resilience',
          '../../packages/telemetry',
        ].map((path) => ({ path: `${path}/tsconfig.build.json` })),
      },
      null,
      2,
    )}\n`,
  );

  await write(
    'tsconfig.json',
    `${JSON.stringify(
      {
        extends: './tsconfig.build.json',
        compilerOptions: {
          noEmit: true,
          // The build config roots at src/; this program also takes test/ and
          // *.config.ts. Nothing is emitted, so the root is the project itself.
          rootDir: '.',
          composite: false,
          incremental: false,
        },
        include: ['src/**/*.ts', 'test/**/*.ts', '*.config.ts'],
        exclude: ['node_modules', 'dist'],
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

/** Configuration validated at boot. The app does not start on invalid config. */
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
 * Domain errors for this service.
 *
 * Each carries a STABLE code from the catalogue: it is what the client keys its
 * behaviour off, so changing the value is a breaking change.
 */
export class ExampleError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(detail: string) {
    super(detail);
  }
}
`,
  );

  await write(
    `src/modules/${moduleName}/application/ports.ts`,
    `/**
 * Application layer ports.
 *
 * Interfaces, never concrete classes: the use case does not know what is on the
 * other side. The Symbols exist because NestJS needs a runtime token, and an
 * interface disappears at compile time.
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
    `/** Commands and results. No \`Request\`, no headers, no HTTP decorators. */

export interface ExampleCommand {
  projectId: string;
}

export interface ExampleResult {
  id: string;
}
`,
  );

  await write(
    `src/modules/${moduleName}/application/use-cases/example.ts`,
    `import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../ports.js';
import type { ExampleCommand, ExampleResult } from '../dto.js';

/**
 * Placeholder use case. Replace it with a real one and delete this.
 *
 * Template rules (reference doc 03 §3.2):
 *   - it takes a command, never the Express \`Request\`;
 *   - it talks only to ports;
 *   - every error path has a test.
 */
@Injectable()
export class Example {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ExampleCommand): Promise<ExampleResult> {
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
import { Example } from '../../application/use-cases/example.js';

/** Adapts HTTP to the use cases. No business rule here. */
@Controller('v1/${name}')
export class ${pascal}Controller {
  constructor(private readonly example: Example) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ id: string }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return this.example.execute({ projectId });
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
import { Example } from './application/use-cases/example.js';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from './application/ports.js';
import { ${pascal}Controller } from './presentation/http/${moduleName}.controller.js';

/** Wiring: the only place that knows all three layers at once. */
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
  providers: [Example, ...adapters],
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
  // Global guard: a route has to declare itself public to escape it.
  // Forgetting the decorator fails closed.
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

// Telemetry starts BEFORE any import that does I/O: auto-instrumentation has to
// wrap the modules at load time.
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
logger.log(\`aia-${name} listening on port \${config.PORT.toString()}\`);
`,
  );

  await write(
    'test/example.spec.ts',
    `import { describe, expect, it } from 'vitest';
import { Example } from '../src/modules/${moduleName}/application/use-cases/example.js';

/**
 * Fakes, not mocks: the test verifies BEHAVIOUR, not the sequence of calls. A
 * test tied to mocks breaks on every refactor without pointing at any real
 * defect.
 */
describe('Example', () => {
  it('returns an identifier', async () => {
    const useCase = new Example(
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
description = "The AIA platform ${name} service"
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
    `"""The AIA platform ${name} service."""

__all__: list[str] = []
`,
  );

  await write(
    `src/${snake}/domain/__init__.py`,
    `"""The service domain.

Pure rules: no FastAPI, no database, no I/O. That is what makes it possible to
test the business rule without starting anything.
"""

__all__: list[str] = []
`,
  );

  await write(
    `src/${snake}/domain/entities.py`,
    `"""Entities and value objects. Plain dataclasses."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Example:
    """Placeholder value object. Replace it with a real one and delete this."""

    id: str
    project_id: str

    def __post_init__(self) -> None:
        if not self.project_id:
            msg = "project_id is required: project is the platform tenant"
            raise ValueError(msg)
`,
  );

  await write(
    `src/${snake}/domain/errors.py`,
    `"""Domain errors for this service."""

from __future__ import annotations

from aia_errors import DomainError, ErrorCode


class ExampleError(DomainError):
    def __init__(self, detail: str) -> None:
        super().__init__(detail, code=ErrorCode.VALIDATION_FAILED, status=400)
`,
  );

  await write(`src/${snake}/application/__init__.py`, '');
  await write(
    `src/${snake}/application/ports.py`,
    `"""Ports as Protocols.

Adapters do not inherit: they merely satisfy the signature, and mypy checks it
(duck typing).
"""

from __future__ import annotations

from typing import Protocol

from ${snake}.domain.entities import Example


class ExampleRepository(Protocol):
    async def find(self, example_id: str) -> Example | None: ...
    async def save(self, example: Example) -> None: ...
`,
  );

  await write(
    `src/${snake}/application/dto.py`,
    `"""Commands and results. No HTTP detail."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExampleCommand:
    project_id: str
`,
  );

  await write(`src/${snake}/application/use_cases/__init__.py`, '');
  await write(
    `src/${snake}/application/use_cases/example.py`,
    `"""Placeholder use case. Replace it with a real one and delete this."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from ${snake}.application.dto import ExampleCommand
from ${snake}.application.ports import ExampleRepository
from ${snake}.domain.entities import Example


@dataclass(slots=True)
class RunExample:
    repository: ExampleRepository

    async def execute(self, command: ExampleCommand) -> Example:
        example = Example(id=str(uuid.uuid4()), project_id=command.project_id)
        await self.repository.save(example)
        return example
`,
  );

  await write(`src/${snake}/infrastructure/__init__.py`, '');
  await write(
    `src/${snake}/infrastructure/in_memory.py`,
    `"""In-memory adapters. Swap for MongoDB once there is real state."""

from __future__ import annotations

from dataclasses import dataclass, field

from ${snake}.domain.entities import Example


@dataclass(slots=True)
class InMemoryExampleRepository:
    _items: dict[str, Example] = field(default_factory=dict)

    async def find(self, example_id: str) -> Example | None:
        return self._items.get(example_id)

    async def save(self, example: Example) -> None:
        self._items[example.id] = example
`,
  );

  await write(
    `src/${snake}/config.py`,
    `"""Configuration validated at startup. 12-factor."""

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
    `"""Dependency composition. Never inside a use case."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from aia_auth import JwtVerifier
from ${snake}.application.use_cases.example import RunExample
from ${snake}.config import Settings, get_settings
from ${snake}.infrastructure.in_memory import InMemoryExampleRepository


@dataclass(slots=True)
class Container:
    settings: Settings
    example: RunExample
    verifier: JwtVerifier


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()
    return Container(
        settings=settings,
        example=RunExample(repository=InMemoryExampleRepository()),
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
    `"""FastAPI routers. They only adapt input and output."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header

from aia_auth import (
    POLICY,
    AccessRequest,
    Principal,
    authorize,
    bearer_token,
    is_internal_service,
)
from aia_errors import ProjectRequiredError
from aia_telemetry import AiaAttr, annotate_active_span
from ${snake}.application.dto import ExampleCommand
from ${snake}.container import get_container

router = APIRouter(prefix="/v1/${name}", tags=["${name}"])
health_router = APIRouter(prefix="/health", tags=["health"])


def _authenticate(
    authorization: Annotated[str | None, Header()] = None,
    x_project_id: Annotated[str | None, Header()] = None,
) -> tuple[Principal, str]:
    """\`Depends\` exists only in presentation (reference doc 03 §3.3)."""
    principal = get_container().verifier.verify(bearer_token(authorization))
    if not x_project_id:
        raise ProjectRequiredError()
    # Named, rather than an unnamed \`if\`: the decision records which branch
    # allowed the call, so a trace shows a service-to-service bypass firing
    # instead of showing nothing.
    authorize(
        is_internal_service | POLICY.READ_PROJECT,
        AccessRequest(principal=principal, project_id=x_project_id),
    )

    annotate_active_span(**{AiaAttr.PROJECT_ID: x_project_id, AiaAttr.PRINCIPAL_ID: principal.id})
    return principal, x_project_id


Authenticated = Annotated[tuple[Principal, str], Depends(_authenticate)]


@router.get("")
async def list_items(auth: Authenticated) -> dict[str, str]:
    _, project_id = auth
    example = await get_container().example.execute(ExampleCommand(project_id=project_id))
    return {"id": example.id, "project_id": example.project_id}


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
    `"""FastAPI application for aia-${name}."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from aia_errors import PROBLEM_CONTENT_TYPE, DomainError, problem_from_unknown
from aia_telemetry import current_trace_id, start_telemetry
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
        # Stack in the log, correlated by trace_id; never in the response.
        logger.exception("request failed at %s", request.url.path)
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
    'tests/test_example.py',
    `"""Test for the placeholder use case."""

from __future__ import annotations

from ${snake}.application.dto import ExampleCommand
from ${snake}.application.use_cases.example import RunExample
from ${snake}.infrastructure.in_memory import InMemoryExampleRepository


async def test_creates_and_persists() -> None:
    repository = InMemoryExampleRepository()
    result = await RunExample(repository=repository).execute(ExampleCommand(project_id="proj-1"))

    assert result.project_id == "proj-1"
    assert await repository.find(result.id) == result
`,
  );
}

/* ------------------------------------------------------------------ */

console.log(`Generating apps/${name} (${runtime}, port ${port}):\n`);
await (runtime === 'node' ? generateNode() : generatePython());

const nextSteps =
  runtime === 'node'
    ? `  1. Add "apps/${name}" to pnpm-workspace.yaml
  2. Add { "path": "./apps/${name}/tsconfig.build.json" } to the references in
     tsconfig.build.json at the repository root
  3. pnpm install && pnpm exec tsc --build tsconfig.build.json`
    : `  1. The uv workspace already includes apps/* — run: uv sync --all-packages
  2. Add the layer contracts to .importlinter (root_packages and layers)`;

console.log(`
Service apps/${name} created.

Next steps:
${nextSteps}
  4. Add the service to deploy/compose/docker-compose.yml
  5. Add it to the chart in deploy/helm/aia-platform/values.yaml and services.yaml
  6. Write the contract in contracts/openapi/${name}.v1.yaml
  7. Replace "Example" with a real use case and delete the skeleton

The dependency rule already applies: 'make arch' fails if domain/ imports from
infrastructure/.
`);

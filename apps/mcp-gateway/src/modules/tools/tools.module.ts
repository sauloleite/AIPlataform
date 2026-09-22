import { randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';
import { Redis } from 'ioredis';
import { Db, MongoClient } from 'mongodb';

import { CONFIG, type McpGatewayConfig } from '../../config/index.js';
import {
  APPROVAL_STORE,
  AUDIT_REPOSITORY,
  BINDING_REPOSITORY,
  CLASSIFICATION_READER,
  CLOCK,
  CONNECTION_REPOSITORY,
  ID_GENERATOR,
  RATE_LIMITER,
  SECRET_RESOLVER,
  TOOL_CATALOG,
  TOOL_EXECUTORS,
  type ApprovalStore,
  type AuditRepository,
  type BindingRepository,
  type ClassificationReader,
  type Clock,
  type ConnectionRepository,
  type IdGenerator,
  type RateLimiter,
  type SecretResolver,
  type ToolCatalog,
  type ToolExecutor,
} from './application/ports.js';
import { InvokeTool } from './application/use-cases/invoke-tool.js';
import { ListBuiltinTools } from './application/use-cases/list-builtin-tools.js';
import { ListEffectiveTools } from './application/use-cases/list-effective-tools.js';
import { BindTool, ListBindings, UnbindTool } from './application/use-cases/manage-bindings.js';
import {
  CreateConnection,
  DeleteConnection,
  ListConnections,
} from './application/use-cases/manage-connections.js';
import { CalculatorExecutor } from './infrastructure/executors/calculator-executor.js';
import { CurrentTimeExecutor } from './infrastructure/executors/current-time-executor.js';
import { KnowledgeSearchExecutor } from './infrastructure/executors/knowledge-search-executor.js';
import { McpExecutor } from './infrastructure/executors/mcp-executor.js';
import { OpenApiExecutor } from './infrastructure/executors/openapi-executor.js';
import {
  WebFetchExecutor,
  isReadableContentType,
} from './infrastructure/executors/web-fetch-executor.js';
import { WebSearchExecutor } from './infrastructure/executors/web-search-executor.js';
import { GovernanceClassificationReader } from './infrastructure/http/governance-classification-reader.js';
import { RegistryToolCatalog } from './infrastructure/http/registry-tool-catalog.js';
import { MongoAuditRepository } from './infrastructure/mongo/audit.repository.js';
import { MongoBindingRepository } from './infrastructure/mongo/binding.repository.js';
import { MongoConnectionRepository } from './infrastructure/mongo/connection.repository.js';
import {
  EnvSecretResolver,
  FileSecretResolver,
  FirstOf,
} from './infrastructure/secrets/secret-resolvers.js';
import { RedisApprovalStore } from './infrastructure/redis/redis-approval-store.js';
import { RedisRateLimiter } from './infrastructure/redis/redis-rate-limiter.js';
import { PublicWebClient } from './infrastructure/web/public-web-client.js';
import {
  SearxngBackend,
  TavilyBackend,
  type SearchBackend,
} from './infrastructure/web-search/search-backends.js';
import { ToolsController } from './presentation/http/tools.controller.js';

/** Wiring: the only place that knows all three layers at once. */
const adapters: Provider[] = [
  { provide: CLOCK, useValue: { now: (): Date => new Date() } satisfies Clock },
  { provide: ID_GENERATOR, useValue: { next: (): string => randomUUID() } satisfies IdGenerator },
  {
    provide: TOOL_CATALOG,
    useFactory: (config: McpGatewayConfig): ToolCatalog =>
      new RegistryToolCatalog(config.REGISTRY_URL),
    inject: [CONFIG],
  },
  {
    provide: BINDING_REPOSITORY,
    useFactory: (db: Db): BindingRepository => new MongoBindingRepository(db),
    inject: [Db],
  },
  {
    provide: AUDIT_REPOSITORY,
    useFactory: (client: MongoClient, db: Db, config: McpGatewayConfig): AuditRepository =>
      new MongoAuditRepository(client, db, config.AUDIT_RETENTION_DAYS),
    inject: [MongoClient, Db, CONFIG],
  },
  {
    provide: CONNECTION_REPOSITORY,
    useFactory: (db: Db): ConnectionRepository => new MongoConnectionRepository(db),
    inject: [Db],
  },
  {
    // File first, environment second (ADR-015): a deployment that mounts a
    // real secret must never be shadowed by a leftover variable.
    provide: SECRET_RESOLVER,
    useFactory: (config: McpGatewayConfig): SecretResolver =>
      new FirstOf([new FileSecretResolver(config.SECRETS_DIR), new EnvSecretResolver()]),
    inject: [CONFIG],
  },
  {
    provide: RATE_LIMITER,
    useFactory: (redis: Redis): RateLimiter => new RedisRateLimiter(redis),
    inject: [Redis],
  },
  {
    provide: APPROVAL_STORE,
    useFactory: (redis: Redis): ApprovalStore => new RedisApprovalStore(redis),
    inject: [Redis],
  },
  {
    provide: CLASSIFICATION_READER,
    useFactory: (config: McpGatewayConfig): ClassificationReader =>
      new GovernanceClassificationReader(config.GOVERNANCE_URL),
    inject: [CONFIG],
  },
  {
    // An array chosen by `supports`, never a switch: adding a tool type is a
    // new executor here and no change in the use case.
    //
    // Every built-in's executor is ALWAYS registered, configured or not. One
    // left out would be reported as "no executor", when the useful answer is
    // which setting is missing -- and that is what `unavailableReason` says.
    provide: TOOL_EXECUTORS,
    useFactory: (
      config: McpGatewayConfig,
      secrets: SecretResolver,
      clock: Clock,
    ): ToolExecutor[] => [
      new McpExecutor(),
      new OpenApiExecutor(),
      new KnowledgeSearchExecutor(config.KNOWLEDGE_URL),
      new WebSearchExecutor(searchBackendFor(config, secrets)),
      new WebFetchExecutor(
        new PublicWebClient({
          // Two megabytes of page before it is cut: generous for an article,
          // a ceiling for this process's memory against a hostile one.
          maxBytes: 2 * 1024 * 1024,
          maxRedirects: 5,
          userAgent: 'AIA-Platform/1.0 (web-fetch built-in)',
          isReadable: isReadableContentType,
        }),
        config.WEB_FETCH_ENABLED
          ? null
          : 'Reading web pages is switched off on this platform (WEB_FETCH_ENABLED)',
      ),
      new CurrentTimeExecutor(clock),
      new CalculatorExecutor(),
    ],
    inject: [CONFIG, SECRET_RESOLVER, CLOCK],
  },
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
        // Critical: without Redis there is no rate limit and no approval
        // store, and serving tools with neither is worse than a clear 503.
        name: 'redis',
        critical: true,
        check: async () => {
          await redis.ping();
          return { status: 'ok' as const };
        },
      },
    ],
    inject: [Db, Redis],
  },
];

const useCases: Provider[] = [
  ListEffectiveTools,
  ListBuiltinTools,
  InvokeTool,
  ListBindings,
  BindTool,
  UnbindTool,
  ListConnections,
  CreateConnection,
  DeleteConnection,
];

function searchBackendFor(config: McpGatewayConfig, secrets: SecretResolver): SearchBackend | null {
  switch (config.WEB_SEARCH_PROVIDER) {
    case 'searxng':
      return new SearxngBackend(config.WEB_SEARCH_SEARXNG_URL);
    case 'tavily':
      return new TavilyBackend(secrets, config.WEB_SEARCH_TAVILY_SECRET_REF);
    case 'none':
      return null;
  }
}

@Module({
  controllers: [ToolsController, HealthController],
  providers: [...adapters, ...useCases],
  exports: [BINDING_REPOSITORY, AUDIT_REPOSITORY],
})
export class ToolsModule {}

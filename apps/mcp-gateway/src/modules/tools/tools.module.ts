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
  type Clock,
  type ConnectionRepository,
  type IdGenerator,
  type RateLimiter,
  type SecretResolver,
  type ToolCatalog,
  type ToolExecutor,
} from './application/ports.js';
import { InvokeTool } from './application/use-cases/invoke-tool.js';
import { ListEffectiveTools } from './application/use-cases/list-effective-tools.js';
import { BindTool, ListBindings, UnbindTool } from './application/use-cases/manage-bindings.js';
import {
  CreateConnection,
  DeleteConnection,
  ListConnections,
} from './application/use-cases/manage-connections.js';
import { KnowledgeSearchExecutor } from './infrastructure/executors/knowledge-search-executor.js';
import { McpExecutor } from './infrastructure/executors/mcp-executor.js';
import { OpenApiExecutor } from './infrastructure/executors/openapi-executor.js';
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
    // An array chosen by `supports`, never a switch: adding a tool type is a
    // new executor here and no change in the use case.
    provide: TOOL_EXECUTORS,
    useFactory: (config: McpGatewayConfig): ToolExecutor[] => [
      new McpExecutor(),
      new OpenApiExecutor(),
      new KnowledgeSearchExecutor(config.KNOWLEDGE_URL),
    ],
    inject: [CONFIG],
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
  InvokeTool,
  ListBindings,
  BindTool,
  UnbindTool,
  ListConnections,
  CreateConnection,
  DeleteConnection,
];

@Module({
  controllers: [ToolsController, HealthController],
  providers: [...adapters, ...useCases],
  exports: [BINDING_REPOSITORY, AUDIT_REPOSITORY],
})
export class ToolsModule {}

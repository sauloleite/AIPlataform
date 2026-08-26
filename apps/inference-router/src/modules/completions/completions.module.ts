import { randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { Db } from 'mongodb';
import { Redis } from 'ioredis';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';
import { CreateChatCompletion } from './application/use-cases/create-chat-completion.js';
import { CreateEmbeddings } from './application/use-cases/create-embeddings.js';
import { ListModels } from './application/use-cases/list-models.js';
import { DeploymentExecutor } from './application/services/deployment-executor.js';
import {
  ALIAS_REGISTRY,
  AUDIT_REPOSITORY,
  BUDGET_LEDGER,
  CLOCK,
  GUARDRAIL,
  ID_GENERATOR,
  MODEL_PROVIDERS,
  POLICY_READER,
  SEMANTIC_CACHE,
  TOKEN_ESTIMATOR,
  USAGE_PUBLISHER,
  type Clock,
  type IdGenerator,
  type ModelProvider,
} from './application/ports.js';
import { AnthropicProvider } from './infrastructure/providers/anthropic.provider.js';
import { GeminiProvider } from './infrastructure/providers/gemini.provider.js';
import { OllamaProvider } from './infrastructure/providers/ollama.provider.js';
import { OpenAiProvider } from './infrastructure/providers/openai.provider.js';
import { RedisBudgetLedger } from './infrastructure/redis/redis-budget-ledger.js';
import { RedisSemanticCache } from './infrastructure/redis/semantic-cache.js';
import { HttpPolicyReader } from './infrastructure/governance/http-policy-reader.js';
import { DisabledGuardrail, HttpGuardrail } from './infrastructure/guardrails/http-guardrail.js';
import { MongoAuditRepository } from './infrastructure/mongo/audit.repository.js';
import { OutboxUsagePublisher } from './infrastructure/messaging/outbox-usage-publisher.js';
import {
  InMemoryAliasRegistry,
  defaultAliasCatalog,
} from './infrastructure/registry/alias-catalog.js';
import { GptTokenEstimator } from './infrastructure/tokens/token-estimator.js';
import { CompletionsController } from './presentation/http/completions.controller.js';
import { CONFIG, type RouterConfig } from '../../config/index.js';
import { ServiceTokenProvider } from '../../shared/service-token.js';

/**
 * Wiring. Unico lugar que conhece dominio, aplicacao e infraestrutura juntos.
 *
 * Todo provedor e registrado, tenha chave ou nao: quem decide se ele participa
 * e a flag `configured`, avaliada pelo DeploymentExecutor. Assim a plataforma
 * sobe identica com uma chave, com quatro ou com nenhuma.
 */
const adapters: Provider[] = [
  {
    provide: MODEL_PROVIDERS,
    useFactory: (config: RouterConfig): ModelProvider[] => [
      new OllamaProvider({ baseUrl: config.OLLAMA_BASE_URL }),
      new OpenAiProvider({
        apiKey: config.OPENAI_API_KEY,
        baseUrl: config.OPENAI_BASE_URL,
      }),
      new GeminiProvider({
        apiKey: config.GEMINI_API_KEY,
        baseUrl: config.GEMINI_BASE_URL,
        apiVersion: config.GEMINI_API_VERSION,
        protocol: config.GEMINI_PROTOCOL,
      }),
      new AnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        baseUrl: config.ANTHROPIC_BASE_URL,
        version: config.ANTHROPIC_VERSION,
      }),
    ],
    inject: [CONFIG],
  },
  {
    provide: ALIAS_REGISTRY,
    useFactory: (config: RouterConfig) =>
      new InMemoryAliasRegistry(
        defaultAliasCatalog({
          ollamaChat: config.OLLAMA_CHAT_MODEL,
          ollamaEmbedding: config.OLLAMA_EMBEDDING_MODEL,
          openaiChat: config.OPENAI_CHAT_MODEL,
          openaiEmbedding: config.OPENAI_EMBEDDING_MODEL,
          geminiChat: config.GEMINI_CHAT_MODEL,
          geminiEmbedding: config.GEMINI_EMBEDDING_MODEL,
          anthropicChat: config.ANTHROPIC_CHAT_MODEL,
        }),
      ),
    inject: [CONFIG],
  },
  {
    provide: BUDGET_LEDGER,
    useFactory: (redis: Redis) => new RedisBudgetLedger(redis),
    inject: [Redis],
  },
  {
    provide: ServiceTokenProvider,
    useFactory: (config: RouterConfig) =>
      new ServiceTokenProvider({
        identityUrl: config.IDENTITY_ISSUER,
        clientId: config.ROUTER_CLIENT_ID,
        clientSecret: config.ROUTER_CLIENT_SECRET,
        scope: 'projects:read',
      }),
    inject: [CONFIG],
  },
  {
    provide: POLICY_READER,
    useFactory: (config: RouterConfig, tokens: ServiceTokenProvider) =>
      new HttpPolicyReader({
        governanceUrl: config.GOVERNANCE_URL,
        serviceToken: () => tokens.get(),
        cacheTtlSeconds: config.POLICY_CACHE_TTL_SECONDS,
        defaultCurrency: config.DEFAULT_CURRENCY,
      }),
    inject: [CONFIG, ServiceTokenProvider],
  },
  {
    provide: GUARDRAIL,
    useFactory: (config: RouterConfig, tokens: ServiceTokenProvider) =>
      config.GUARDRAILS_URL === undefined
        ? new DisabledGuardrail()
        : new HttpGuardrail({
            guardrailsUrl: config.GUARDRAILS_URL,
            serviceToken: () => tokens.get(),
            enabled: true,
          }),
    inject: [CONFIG, ServiceTokenProvider],
  },
  {
    provide: SEMANTIC_CACHE,
    useFactory: (redis: Redis, config: RouterConfig) =>
      new RedisSemanticCache(redis, {
        enabled: config.SEMANTIC_CACHE_ENABLED,
        ttlSeconds: config.SEMANTIC_CACHE_TTL_SECONDS,
      }),
    inject: [Redis, CONFIG],
  },
  {
    provide: AUDIT_REPOSITORY,
    useFactory: (db: Db, config: RouterConfig) =>
      new MongoAuditRepository(db, config.AUDIT_RETENTION_DAYS),
    inject: [Db, CONFIG],
  },
  {
    provide: USAGE_PUBLISHER,
    useFactory: (db: Db) => new OutboxUsagePublisher(db),
    inject: [Db],
  },
  { provide: TOKEN_ESTIMATOR, useClass: GptTokenEstimator },
  { provide: CLOCK, useValue: { now: (): Date => new Date() } satisfies Clock },
  { provide: ID_GENERATOR, useValue: { next: (): string => randomUUID() } satisfies IdGenerator },
  {
    provide: HEALTH_CHECKS,
    useFactory: (db: Db, redis: Redis, config: RouterConfig): DependencyCheck[] => [
      {
        name: 'mongodb',
        // Sem MongoDB nao ha auditoria nem outbox: atender seria perder evidencia.
        critical: true,
        check: async () => {
          await db.command({ ping: 1 });
          return { status: 'ok' as const };
        },
      },
      {
        name: 'redis',
        // Sem Redis o router degrada para budget_unverified, mas continua servindo.
        critical: false,
        check: async () => {
          await redis.ping();
          return { status: 'ok' as const };
        },
      },
      {
        name: 'governance',
        critical: false,
        check: async () => {
          const response = await fetch(`${config.GOVERNANCE_URL}/health/live`, {
            signal: AbortSignal.timeout(1500),
          });
          return response.ok
            ? { status: 'ok' as const }
            : { status: 'degraded' as const, detail: 'politica sera servida do cache' };
        },
      },
      {
        name: 'ollama',
        critical: false,
        check: async () => {
          const response = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
            signal: AbortSignal.timeout(1500),
          });
          return response.ok
            ? { status: 'ok' as const }
            : { status: 'degraded' as const, detail: 'modelos locais indisponiveis' };
        },
      },
    ],
    inject: [Db, Redis, CONFIG],
  },
];

@Module({
  controllers: [CompletionsController, HealthController],
  providers: [CreateChatCompletion, CreateEmbeddings, ListModels, DeploymentExecutor, ...adapters],
})
export class CompletionsModule {}

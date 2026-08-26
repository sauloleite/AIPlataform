import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/**
 * Configuracao do router. Todo provedor e opcional: a plataforma sobe com
 * qualquer subconjunto de chaves, e o Ollama nao precisa de nenhuma.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DATABASE: z.string().default('aia_router'),
  REDIS_URL: z.string().min(1),

  IDENTITY_ISSUER: z.string().url(),
  IDENTITY_AUDIENCE: z.string().default('aia-platform'),
  IDENTITY_JWKS_URL: z.string().url().optional(),
  /**
   * Credencial do proprio router, para falar com governance e guardrails.
   * Substitui a identidade gerenciada de nuvem (ADR-012).
   */
  ROUTER_CLIENT_ID: z.string().default('aia-inference-router'),
  ROUTER_CLIENT_SECRET: z.string().default(''),

  GOVERNANCE_URL: z.string().url(),
  GUARDRAILS_URL: z.string().url().optional(),

  POLICY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  BUDGET_UNVERIFIED_MAX_TOKENS: z.coerce.number().int().positive().default(2000),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  DEFAULT_CURRENCY: z.string().length(3).default('BRL'),

  SEMANTIC_CACHE_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  SEMANTIC_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // --- Provedores -----------------------------------------------------------
  OLLAMA_BASE_URL: z.string().url().default('http://ollama:11434'),
  OLLAMA_CHAT_MODEL: z.string().default('llama3.2:1b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  GEMINI_API_KEY: z.string().default(''),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  GEMINI_API_VERSION: z.string().default('v1beta'),
  /**
   * `interactions` e a interface atual (GA em junho de 2026);
   * `generate-content` e a anterior, ainda suportada.
   */
  GEMINI_PROTOCOL: z.enum(['interactions', 'generate-content']).default('interactions'),
  GEMINI_CHAT_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_EMBEDDING_MODEL: z.string().default('text-embedding-004'),

  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  ANTHROPIC_CHAT_MODEL: z.string().default('claude-sonnet-4-5'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  AIA_CONTENT_CAPTURE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
});

export type RouterConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RouterConfig {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('RouterConfig');

import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/**
 * Router configuration. Every provider is optional: the platform starts with any
 * subset of keys, and Ollama needs none at all.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DATABASE: z.string().default('aia_router'),
  REDIS_URL: z.string().min(1),

  // The `iss` CLAIM tokens carry, and what this service checks them against.
  // It is an identifier, not necessarily somewhere reachable.
  IDENTITY_ISSUER: z.string().url(),
  // WHERE aia-identity actually is, for the client_credentials grant. Defaults
  // to the issuer, which is right whenever they are the same host -- and they
  // are not when the services run outside the compose network, where
  // `http://identity:3001` resolves to nothing. `IDENTITY_JWKS_URL` already
  // draws this distinction for key discovery; the token endpoint needs it too.
  IDENTITY_URL: z.string().url().optional(),
  IDENTITY_AUDIENCE: z.string().default('aia-platform'),
  IDENTITY_JWKS_URL: z.string().url().optional(),
  /**
   * The router's own credential, for talking to governance and guardrails.
   * It replaces managed cloud identity (ADR-012).
   */
  ROUTER_CLIENT_ID: z.string().default('aia-inference-router'),
  ROUTER_CLIENT_SECRET: z.string().default(''),

  GOVERNANCE_URL: z.string().url(),
  GUARDRAILS_URL: z.string().url().optional(),

  POLICY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  BUDGET_UNVERIFIED_MAX_TOKENS: z.coerce.number().int().positive().default(2000),
  // The fallback when governance does not report a project's retention, which
  // only happens against a governance older than the field. Retention itself is
  // a project policy now (doc 02 §10.2), not a property of this deployment.
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  DEFAULT_CURRENCY: z.string().length(3).default('BRL'),

  SEMANTIC_CACHE_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  SEMANTIC_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // --- Provedores -----------------------------------------------------------
  // Empty DISABLES Ollama, the same way an empty key disables OpenAI, Gemini or
  // Anthropic. A plain `.url()` made this the one provider that could not be
  // turned off, so a project that no longer wants a local model kept silently
  // falling back to one -- and a local model answering where a hosted one
  // failed looks like success, only thirty times slower.
  OLLAMA_BASE_URL: z.union([z.literal(''), z.string().url()]).default('http://ollama:11434'),
  OLLAMA_CHAT_MODEL: z.string().default('llama3.2:1b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  // Gemini keys. A quota is per key, so several of them multiply the ceiling
  // AND give failover: the retry the router already performs after a 429 lands
  // on the next key.
  //
  // Numbered slots are the ordinary way to set them -- one key per line is what
  // a person can paste into a .env without losing track of which is which.
  // `GEMINI_API_KEYS` takes a comma-separated list for more than three, and the
  // bare `GEMINI_API_KEY` still works. Every form is used, together.
  GEMINI_API_KEY_1: z.string().default(''),
  GEMINI_API_KEY_2: z.string().default(''),
  GEMINI_API_KEY_3: z.string().default(''),
  GEMINI_API_KEYS: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  GEMINI_API_VERSION: z.string().default('v1beta'),
  /**
   * `interactions` is the current interface (GA in June 2026);
   * `generate-content` is the previous one, still supported.
   */
  // `generate-content` is the endpoint this adapter speaks correctly. The
  // newer `interactions` interface expects a `step_list` body for the current
  // models, which `interactionsBody` does not build yet.
  GEMINI_PROTOCOL: z.enum(['interactions', 'generate-content']).default('generate-content'),
  // An alias, not a pinned version: Google retires versioned models for new
  // keys, and a pinned default turns every fresh install into a 404.
  GEMINI_CHAT_MODEL: z.string().default('gemini-flash-latest'),
  // A stronger Gemini for `chat-advanced`. It is also what makes a credible
  // evaluation judge available with only Gemini configured: a model asked to
  // grade its own answer agrees with itself.
  //
  // Not `pro-latest`: Pro is not on the free tier and answers 429 the moment
  // it is asked, and a judge that cannot be reached fails a suite for a reason
  // that has nothing to do with quality. `gemini-3-flash-preview` is a
  // genuinely different and stronger model from the `flash-lite` behind
  // `chat-fast`, which is what a judge has to be.
  GEMINI_ADVANCED_MODEL: z.string().default('gemini-3-flash-preview'),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),

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

export type GeminiKeyConfig = Pick<
  RouterConfig,
  | 'GEMINI_API_KEY'
  | 'GEMINI_API_KEYS'
  | 'GEMINI_API_KEY_1'
  | 'GEMINI_API_KEY_2'
  | 'GEMINI_API_KEY_3'
>;

/**
 * Every Gemini key that is configured, in the order they will be used.
 *
 * All three forms are COLLECTED rather than one of them winning: somebody who
 * fills a numbered slot and leaves an old `GEMINI_API_KEY` in place meant to
 * use both, and quietly ignoring one is the kind of thing nobody notices until
 * a quota runs out earlier than it should.
 *
 * Blanks are dropped -- a trailing comma is the easiest way to end up with one,
 * and an empty key would rotate into a guaranteed 401 every Nth request.
 *
 * Duplicates are dropped too. The same key twice does not double a quota; it
 * halves the worth of the rotation while looking like it doubled it.
 */
export function geminiKeys(config: GeminiKeyConfig): string[] {
  const candidates = [
    config.GEMINI_API_KEY_1,
    config.GEMINI_API_KEY_2,
    config.GEMINI_API_KEY_3,
    ...config.GEMINI_API_KEYS.split(','),
    config.GEMINI_API_KEY,
  ];

  const keys: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.trim();
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RouterConfig {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('RouterConfig');

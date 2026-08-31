import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/** Configuration validated at boot. The app does not start on invalid config. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3004),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DATABASE: z.string().default('aia_registry'),
  REDIS_URL: z.string().min(1),

  IDENTITY_ISSUER: z.string().url(),
  IDENTITY_AUDIENCE: z.string().default('aia-platform'),
  IDENTITY_JWKS_URL: z.string().url().optional(),

  // Where a definition's references are resolved at publish time.
  INFERENCE_ROUTER_URL: z.string().url().default('http://inference-router:3000'),
  // Empty until aia-knowledge exists. A definition attaching a vector store
  // then refuses to publish rather than publishing retrieval that does nothing.
  KNOWLEDGE_URL: z.string().default(''),

  REGISTRY_CLIENT_ID: z.string().default('aia-registry'),
  REGISTRY_CLIENT_SECRET: z.string().default(''),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type RegistryConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RegistryConfig {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('RegistryConfig');

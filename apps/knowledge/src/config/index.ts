import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/** Configuration validated at boot. The app does not start on invalid config. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3007),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DATABASE: z.string().default('aia_knowledge'),
  REDIS_URL: z.string().min(1),

  IDENTITY_ISSUER: z.string().url(),
  IDENTITY_AUDIENCE: z.string().default('aia-platform'),
  IDENTITY_JWKS_URL: z.string().url().optional(),

  QDRANT_URL: z.string().url().default('http://qdrant:6333'),
  QDRANT_API_KEY: z.string().optional(),

  MINIO_ENDPOINT: z.string().url().default('http://minio:9000'),
  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  KNOWLEDGE_BUCKET: z.string().default('aia-documents'),

  // Embeddings go through the router, never straight to a provider.
  INFERENCE_ROUTER_URL: z.string().url().default('http://inference-router:3000'),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(256).default(32),

  // Empty until aia-document-processing exists: only text and markdown parse
  // locally, and any other type fails that one job rather than the service.
  DOCUMENT_PROCESSING_URL: z.string().default(''),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type KnowledgeConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): KnowledgeConfig {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('KnowledgeConfig');

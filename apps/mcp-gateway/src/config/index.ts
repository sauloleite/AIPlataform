import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/** Configuration validated at boot. The app does not start on invalid config. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3006),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DATABASE: z.string().default('aia_mcp_gateway'),
  REDIS_URL: z.string().min(1),

  IDENTITY_ISSUER: z.string().url(),
  IDENTITY_AUDIENCE: z.string().default('aia-platform'),
  IDENTITY_JWKS_URL: z.string().url().optional(),

  // Tool DEFINITIONS live in the registry; this service owns only the bindings.
  REGISTRY_URL: z.string().url().default('http://registry:3004'),
  // Empty disables the file_search built-in, the way a missing provider key
  // disables one provider rather than the whole service.
  KNOWLEDGE_URL: z.string().default(''),

  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),

  // Where a connection's secret is read from (ADR-015 level 2 and 3). Empty
  // leaves only the environment resolver, which is the development case.
  SECRETS_DIR: z.string().default('/run/secrets'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type McpGatewayConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): McpGatewayConfig {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('McpGatewayConfig');

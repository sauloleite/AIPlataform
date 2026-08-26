import { z } from 'zod';
import { validateConfig } from '@aia/nest';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DATABASE: z.string().default('aia_governance'),
  REDIS_URL: z.string().min(1),

  IDENTITY_ISSUER: z.string().url(),
  IDENTITY_AUDIENCE: z.string().default('aia-platform'),
  IDENTITY_JWKS_URL: z.string().url().optional(),

  /** Default budget currency when the client does not supply one. */
  DEFAULT_CURRENCY: z.string().length(3).default('BRL'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type GovernanceConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): GovernanceConfig {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('GovernanceConfig');

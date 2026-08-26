import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/**
 * Configuration validated at start-up. Twelve-factor: everything comes from the
 * environment.
 *
 * In production a missing signing key fails the boot: an ephemeral pair would
 * invalidate every existing token on the next restart.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    MONGO_URI: z.string().min(1),
    MONGO_DATABASE: z.string().default('aia_identity'),
    REDIS_URL: z.string().min(1),

    IDENTITY_ISSUER: z.string().url(),
    IDENTITY_AUDIENCE: z.string().default('aia-platform'),
    IDENTITY_ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(3600),
    /** HMAC pepper used when hashing PATs. */
    IDENTITY_TOKEN_PEPPER: z.string().min(16).default('dev-pepper-troque-em-producao'),
    /** PKCS#8 private key in PEM, with real newlines or literal \n. */
    IDENTITY_SIGNING_PRIVATE_KEY: z.string().optional(),
    IDENTITY_SIGNING_PUBLIC_KEY: z.string().optional(),
    IDENTITY_SIGNING_KID: z.string().default('aia-1'),

    IDENTITY_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
    IDENTITY_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
    /**
     * Service clients registered at start-up, as JSON:
     *   [{"clientId":"aia-inference-router","secret":"...","scopes":["projects:read"]}]
     *
     * With no managed cloud identity, this is how one service proves who it is
     * to another (reference doc 02 §6).
     */
    IDENTITY_BOOTSTRAP_SERVICE_CLIENTS: z.string().default('[]'),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && config.IDENTITY_SIGNING_PRIVATE_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_SIGNING_PRIVATE_KEY'],
        message:
          'required in production: without a persisted key, restarting the service invalidates every token',
      });
    }
    if (
      config.NODE_ENV === 'production' &&
      config.IDENTITY_TOKEN_PEPPER === 'dev-pepper-troque-em-producao'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_TOKEN_PEPPER'],
        message: 'the default pepper must not reach production',
      });
    }
  });

export type IdentityConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const config = validateConfig(schema, source);
  return {
    ...config,
    // A key in an environment variable usually arrives with literal \n.
    ...(config.IDENTITY_SIGNING_PRIVATE_KEY !== undefined && {
      IDENTITY_SIGNING_PRIVATE_KEY: config.IDENTITY_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    ...(config.IDENTITY_SIGNING_PUBLIC_KEY !== undefined && {
      IDENTITY_SIGNING_PUBLIC_KEY: config.IDENTITY_SIGNING_PUBLIC_KEY.replace(/\\n/g, '\n'),
    }),
  };
}

export const CONFIG = Symbol('IdentityConfig');

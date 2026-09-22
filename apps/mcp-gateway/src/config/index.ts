import { z } from 'zod';
import { validateConfig } from '@aia/nest';

/** Configuration validated at boot. The app does not start on invalid config. */
const schema = z
  .object({
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
    // Where a project's classification is read, for the built-ins that send
    // data off the platform. Empty leaves those unavailable -- never allowed
    // unchecked (ADR-010).
    GOVERNANCE_URL: z.string().default(''),

    // The web_search built-in's backend. `none` switches it off for the whole
    // platform; every other built-in is unaffected.
    WEB_SEARCH_PROVIDER: z.enum(['none', 'searxng', 'tavily']).default('none'),
    WEB_SEARCH_SEARXNG_URL: z.string().default(''),
    // A secret's NAME (ADR-015), resolved like a connection's: a file under
    // SECRETS_DIR first, then AIA_SECRET_TAVILY_API_KEY.
    WEB_SEARCH_TAVILY_SECRET_REF: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .default('tavily_api_key'),

    // An operator whose platform must never read the web switches it off here,
    // for every project at once. `z.coerce.boolean` would read "false" as true.
    WEB_FETCH_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),

    // Where a connection's secret is read from (ADR-015 level 2 and 3). Empty
    // leaves only the environment resolver, which is the development case.
    SECRETS_DIR: z.string().default('/run/secrets'),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((config, context) => {
    // Refused at boot rather than reported as an unavailable tool: naming a
    // backend and not saying where it is, is a typo, not a choice.
    if (config.WEB_SEARCH_PROVIDER === 'searxng' && !isHttpUrl(config.WEB_SEARCH_SEARXNG_URL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB_SEARCH_SEARXNG_URL'],
        message: 'must be an http(s) URL when WEB_SEARCH_PROVIDER is searxng',
      });
    }
  });

export type McpGatewayConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): McpGatewayConfig {
  return validateConfig(schema, source);
}

export const CONFIG = Symbol('McpGatewayConfig');

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

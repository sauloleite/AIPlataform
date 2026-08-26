import { z } from 'zod';

/**
 * Configuration validated at boot. The console does not start on invalid
 * configuration, exactly like every other service on the platform.
 *
 * Every value here is SERVER-side. Nothing is prefixed `NEXT_PUBLIC_`, and that
 * is deliberate: a `NEXT_PUBLIC_` variable is inlined into the JavaScript bundle
 * and is therefore public. The browser talks only to this app's own routes.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3005),

  IDENTITY_URL: z.string().url().default('http://identity:3001'),
  GOVERNANCE_URL: z.string().url().default('http://governance:3002'),
  INFERENCE_ROUTER_URL: z.string().url().default('http://inference-router:3000'),

  PLATFORM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type WebConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}

import { z } from 'zod';

/**
 * Configuration validated at boot. The console does not start on invalid
 * configuration, exactly like every other service on the platform.
 *
 * Every value here is SERVER-side. Nothing is prefixed `NEXT_PUBLIC_`, and that
 * is deliberate: a `NEXT_PUBLIC_` variable is inlined into the JavaScript bundle
 * and is therefore public. The browser talks only to this app's own routes.
 */
// NODE_ENV is deliberately absent. Next's standalone server overwrites it to
// 'production' at startup regardless of the environment, so reading it here
// would describe the build rather than the deployment and mislead whoever
// reached for it. Whether the connection is encrypted comes from the request
// itself -- see `servedOverHttps`.
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3005),

  IDENTITY_URL: z.string().url().default('http://identity:3001'),
  GOVERNANCE_URL: z.string().url().default('http://governance:3002'),
  INFERENCE_ROUTER_URL: z.string().url().default('http://inference-router:3000'),
  REGISTRY_URL: z.string().url().default('http://registry:3004'),
  KNOWLEDGE_URL: z.string().url().default('http://knowledge:3007'),
  MCP_GATEWAY_URL: z.string().url().default('http://mcp-gateway:3006'),
  AGENT_RUNTIME_URL: z.string().url().default('http://agent-runtime:8002'),
  EVALUATION_URL: z.string().url().default('http://evaluation:8003'),
  // Tempo's query API, inside the LGTM image. Empty is allowed and disables
  // the Traces screen: an observability backend that is down should not take
  // the console with it.
  TEMPO_URL: z.string().default('http://lgtm:3200'),

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

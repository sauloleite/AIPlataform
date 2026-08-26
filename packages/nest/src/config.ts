import type { z } from 'zod';

/**
 * Validates configuration at start-up (reference doc 03 §3.2).
 *
 * The application does NOT start with invalid configuration: failing at boot is
 * cheap, failing on the first production request is not.
 *
 * The generic is over the SCHEMA rather than the output type, because schemas
 * using `default()` and `transform()` have different input and output types —
 * tying them together would reject exactly the real configuration schemas.
 */
export function validateConfig<S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data as z.infer<S>;

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid configuration. Fix the environment:\n${problems}`);
}

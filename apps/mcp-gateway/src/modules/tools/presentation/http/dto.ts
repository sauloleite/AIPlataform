/** The wire shape, validated at the boundary. */
import { z } from 'zod';
import { ValidationError } from '@aia/errors';

const invoke = z.object({
  arguments: z.record(z.unknown()).default({}),
  approval_id: z.string().min(1).optional(),
});

const bind = z.object({
  enabled: z.boolean().default(true),
  rate_limit_per_minute: z.number().int().min(1).nullable().optional(),
  require_approval: z.boolean().nullable().optional(),
});

export type InvokeBody = z.infer<typeof invoke>;
export type BindBody = z.infer<typeof bind>;

export const parseInvoke = (body: unknown): InvokeBody => parse(invoke, body);
export const parseBind = (body: unknown): BindBody => parse(bind, body);

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('Invalid request body', {
      issues: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    });
  }
  return result.data as z.infer<S>;
}

const createConnectionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: z.enum(['bearer', 'api_key', 'basic', 'none']),
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  // A NAME, never a value. The pattern forbids a path separator, because the
  // file resolver reads this under a directory.
  secret_ref: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
});

export type CreateConnectionBody = z.infer<typeof createConnectionSchema>;

export function parseCreateConnection(body: unknown): CreateConnectionBody {
  const parsed = createConnectionSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid connection', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  if (parsed.data.kind !== 'none' && parsed.data.secret_ref === undefined) {
    throw new ValidationError('A connection of this kind needs a secret_ref', {
      kind: parsed.data.kind,
    });
  }
  return parsed.data;
}

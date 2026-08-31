/** The wire shape, validated at the boundary. snake_case out, camelCase in. */
import { z } from 'zod';
import { ValidationError } from '@aia/errors';

/**
 * Strict, unlike the rest.
 *
 * An unknown key here is a client that guessed the casing -- `is_public` for
 * `public` -- and zod would drop it silently, leaving `public` at its default
 * of TRUE. The one field whose absence fails OPEN is exactly the one a typo
 * removes, so an unrecognised key is a 400 rather than a document quietly
 * published to the whole project.
 */
const acl = z
  .object({
    public: z.boolean().optional(),
    groups: z.array(z.string()).optional(),
    principals: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const createStore = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().max(2000).optional(),
  embedding_alias: z.string().min(1).default('embedding-default'),
  chunking: z
    .object({
      kind: z.string().optional(),
      max_tokens: z.number().int().optional(),
      overlap_tokens: z.number().int().optional(),
    })
    .optional(),
});

const registerDocument = z.object({
  title: z.string().min(1).max(500),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().positive().optional(),
  acl,
});

const search = z.object({
  query: z.string().min(1).max(8000),
  top_k: z.number().int().min(1).max(50).default(5),
  mode: z.enum(['vector', 'hybrid']).default('hybrid'),
  min_score: z.number().optional(),
});

export type CreateStoreBody = z.infer<typeof createStore>;
export type RegisterDocumentBody = z.infer<typeof registerDocument>;
const visibility = z.object({ visibility: z.enum(['private', 'public']) });

export type SearchBody = z.infer<typeof search>;
export type VisibilityBody = z.infer<typeof visibility>;

export const parseCreateStore = (body: unknown): CreateStoreBody => parse(createStore, body);
export const parseRegisterDocument = (body: unknown): RegisterDocumentBody =>
  parse(registerDocument, body);
export const parseSearch = (body: unknown): SearchBody => parse(search, body);
export const parseVisibility = (body: unknown): VisibilityBody => parse(visibility, body);

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

export function toAclInput(body: RegisterDocumentBody): {
  isPublic?: boolean;
  groups?: string[];
  principals?: string[];
} {
  const value = body.acl;
  if (value === undefined) return {};
  return {
    ...(value.public !== undefined && { isPublic: value.public }),
    ...(value.groups !== undefined && { groups: value.groups }),
    ...(value.principals !== undefined && { principals: value.principals }),
  };
}

export function toChunkingInput(body: CreateStoreBody): {
  kind?: string;
  maxTokens?: number;
  overlapTokens?: number;
} {
  const value = body.chunking;
  if (value === undefined) return {};
  return {
    ...(value.kind !== undefined && { kind: value.kind }),
    ...(value.max_tokens !== undefined && { maxTokens: value.max_tokens }),
    ...(value.overlap_tokens !== undefined && { overlapTokens: value.overlap_tokens }),
  };
}

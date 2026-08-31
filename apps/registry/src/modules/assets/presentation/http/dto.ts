/**
 * The wire shape, validated at the boundary.
 *
 * The contract is snake_case; the domain is camelCase. Translating here keeps
 * the entities from carrying the transport's naming, and zod means a malformed
 * body becomes `validation_failed` rather than an exception three layers in.
 */
import { z } from 'zod';
import { ValidationError } from '@aia/errors';

import {
  ASSET_KINDS,
  BUILTIN_TOOLS,
  RISK_LEVELS,
  TOOL_TYPES,
  type AssetDefinition,
} from '../../domain/value-objects/index.js';

const toolRef = z.object({
  asset_id: z.string().min(1),
  version: z.number().int().positive().nullable().optional(),
});

const storeRef = z.object({ store_id: z.string().min(1) });

const agentDefinition = z.object({
  kind: z.literal('agent'),
  instructions: z.string().min(1).max(100_000),
  model_alias: z.string().min(1),
  tools: z.array(toolRef).default([]),
  knowledge: z.array(storeRef).default([]),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

const toolDefinition = z.object({
  kind: z.literal('tool'),
  tool_type: z.enum(TOOL_TYPES),
  risk_level: z.enum(RISK_LEVELS),
  endpoint: z.string().optional(),
  builtin_id: z.enum(BUILTIN_TOOLS).optional(),
  parameters: z.record(z.unknown()).optional(),
  connection_id: z.string().optional(),
});

const promptDefinition = z.object({
  kind: z.literal('prompt'),
  template: z.string().min(1).max(100_000),
  variables: z.array(z.string()).default([]),
});

const definition = z.discriminatedUnion('kind', [
  agentDefinition,
  toolDefinition,
  promptDefinition,
]);

export type DefinitionBody = z.infer<typeof definition>;

const createAsset = z.object({
  kind: z.enum(ASSET_KINDS),
  slug: z.string(),
  name: z.string(),
  description: z.string().max(2000).optional(),
  definition,
});

const updateDraft = z.object({
  definition,
  expected_version: z.number().int().positive(),
  name: z.string().optional(),
  description: z.string().max(2000).optional(),
});

export type CreateAssetBody = z.infer<typeof createAsset>;
export type UpdateDraftBody = z.infer<typeof updateDraft>;

export function parseCreateAsset(body: unknown): CreateAssetBody {
  return parse(createAsset, body);
}

export function parseUpdateDraft(body: unknown): UpdateDraftBody {
  return parse(updateDraft, body);
}

// Generic over the SCHEMA, not the output type: `.default([])` makes zod's
// input and output types differ, and `ZodType<T>` would force them equal.
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Details carry scalars only, so each issue is flattened to one string.
    throw new ValidationError('Invalid request body', {
      issues: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    });
  }
  return result.data as z.infer<S>;
}

/** snake_case on the wire, camelCase in the domain. */
export function toAssetDefinition(body: DefinitionBody): AssetDefinition {
  switch (body.kind) {
    case 'agent':
      return {
        kind: 'agent',
        instructions: body.instructions,
        modelAlias: body.model_alias,
        tools: body.tools.map((reference) => ({
          assetId: reference.asset_id,
          version: reference.version ?? null,
        })),
        knowledge: body.knowledge.map((reference) => ({ storeId: reference.store_id })),
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { topP: body.top_p }),
        ...(body.max_output_tokens !== undefined && { maxOutputTokens: body.max_output_tokens }),
      };
    case 'tool':
      return {
        kind: 'tool',
        toolType: body.tool_type,
        riskLevel: body.risk_level,
        ...(body.endpoint !== undefined && { endpoint: body.endpoint }),
        ...(body.builtin_id !== undefined && { builtinId: body.builtin_id }),
        ...(body.parameters !== undefined && { parameters: body.parameters }),
        ...(body.connection_id !== undefined && { connectionId: body.connection_id }),
      };
    case 'prompt':
      return { kind: 'prompt', template: body.template, variables: body.variables };
  }
}

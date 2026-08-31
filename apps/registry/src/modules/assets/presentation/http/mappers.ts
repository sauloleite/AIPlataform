import type { AssetDetailView, AssetVersionView, AssetView } from '../../application/dto.js';
import type { AssetDefinition } from '../../domain/value-objects/index.js';

/**
 * Application views translated into the shape the contract publishes.
 *
 * The application layer names things the way TypeScript does; the wire is
 * snake_case because `contracts/openapi/registry.v1.yaml` says so, and the
 * contract is the source. Serialising a view straight out of a controller ties
 * an external API to an internal field name — rename the field and every client
 * breaks silently.
 */

export function toAssetResponse(asset: AssetView): Record<string, unknown> {
  return {
    id: asset.id,
    project_id: asset.projectId,
    kind: asset.kind,
    slug: asset.slug,
    name: asset.name,
    ...(asset.description !== undefined && { description: asset.description }),
    owner_principal_id: asset.ownerPrincipalId,
    published_version: asset.publishedVersion,
    draft_version: asset.draftVersion,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
}

export function toAssetDetailResponse(asset: AssetDetailView): Record<string, unknown> {
  return {
    ...toAssetResponse(asset),
    versions: asset.versions.map(toVersionResponse),
  };
}

export function toVersionResponse(version: AssetVersionView): Record<string, unknown> {
  return {
    asset_id: version.assetId,
    version: version.version,
    status: version.status,
    definition: toDefinitionResponse(version.definition),
    published_at: version.publishedAt ?? null,
    published_by: version.publishedBy ?? null,
    updated_at: version.updatedAt,
    revision: version.revision,
  };
}

/**
 * The definition is discriminated by `kind`, so a map of writers keeps a new
 * asset kind from meaning an edit here (Open/Closed) — it means one more entry.
 */
const DEFINITION_WRITERS: {
  [K in AssetDefinition['kind']]: (
    definition: Extract<AssetDefinition, { kind: K }>,
  ) => Record<string, unknown>;
} = {
  agent: (definition) => ({
    kind: 'agent',
    instructions: definition.instructions,
    model_alias: definition.modelAlias,
    tools: definition.tools.map((tool) => ({ asset_id: tool.assetId, version: tool.version })),
    knowledge: definition.knowledge.map((store) => ({ store_id: store.storeId })),
    ...(definition.temperature !== undefined && { temperature: definition.temperature }),
    ...(definition.topP !== undefined && { top_p: definition.topP }),
    ...(definition.maxOutputTokens !== undefined && {
      max_output_tokens: definition.maxOutputTokens,
    }),
  }),
  tool: (definition) => ({
    kind: 'tool',
    tool_type: definition.toolType,
    risk_level: definition.riskLevel,
    ...(definition.endpoint !== undefined && { endpoint: definition.endpoint }),
    ...(definition.builtinId !== undefined && { builtin_id: definition.builtinId }),
    ...(definition.parameters !== undefined && { parameters: definition.parameters }),
    ...(definition.connectionId !== undefined && { connection_id: definition.connectionId }),
  }),
  prompt: (definition) => ({
    kind: 'prompt',
    template: definition.template,
    variables: [...definition.variables],
  }),
};

export function toDefinitionResponse(definition: AssetDefinition): Record<string, unknown> {
  switch (definition.kind) {
    case 'agent':
      return DEFINITION_WRITERS.agent(definition);
    case 'tool':
      return DEFINITION_WRITERS.tool(definition);
    case 'prompt':
      return DEFINITION_WRITERS.prompt(definition);
  }
}

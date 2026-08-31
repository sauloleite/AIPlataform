/**
 * The console's view of aia-registry.
 *
 * A gateway per service rather than one that knows every backend: a page
 * listing agents should not depend on an interface that also knows how to set a
 * budget.
 */

export type AssetKind = 'agent' | 'tool' | 'prompt';
export type VersionStatus = 'draft' | 'published' | 'deprecated';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface AssetSummary {
  id: string;
  kind: AssetKind;
  slug: string;
  name: string;
  description?: string;
  publishedVersion: number | null;
  draftVersion: number | null;
  updatedAt: string;
}

export interface AgentDefinition {
  kind: 'agent';
  instructions: string;
  modelAlias: string;
  tools: { assetId: string; version: number | null }[];
  knowledge: { storeId: string }[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface ToolDefinition {
  kind: 'tool';
  toolType: 'mcp' | 'openapi' | 'function' | 'builtin';
  riskLevel: RiskLevel;
  endpoint?: string;
  builtinId?: string;
}

export interface PromptDefinition {
  kind: 'prompt';
  template: string;
  variables: string[];
}

export type AssetDefinition = AgentDefinition | ToolDefinition | PromptDefinition;

export interface AssetVersionSummary {
  assetId: string;
  version: number;
  status: VersionStatus;
  definition: AssetDefinition;
  publishedAt?: string;
  updatedAt: string;
  /** Echoed back on the next write so a concurrent edit is refused. */
  revision: number;
}

export interface AssetDetail extends AssetSummary {
  versions: AssetVersionSummary[];
}

export interface CreateAssetInput {
  kind: AssetKind;
  slug: string;
  name: string;
  description?: string;
  definition: AssetDefinition;
}

export interface RegistryGateway {
  listAssets(accessToken: string, projectId: string, kind?: AssetKind): Promise<AssetSummary[]>;
  getAsset(accessToken: string, projectId: string, assetId: string): Promise<AssetDetail>;
  createAsset(
    accessToken: string,
    projectId: string,
    input: CreateAssetInput,
  ): Promise<AssetVersionSummary>;
  updateDraft(
    accessToken: string,
    projectId: string,
    assetId: string,
    input: { definition: AssetDefinition; expectedVersion: number; name?: string },
  ): Promise<AssetVersionSummary>;
  publish(accessToken: string, projectId: string, assetId: string): Promise<AssetVersionSummary>;
}

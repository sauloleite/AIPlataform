/** What an asset can be. A vector store is not here: aia-knowledge owns it (ADR-016). */
export const ASSET_KINDS = ['agent', 'tool', 'prompt'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const VERSION_STATUSES = ['draft', 'published', 'deprecated'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const TOOL_TYPES = ['mcp', 'openapi', 'function', 'builtin'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const BUILTIN_TOOLS = ['file_search', 'code_interpreter', 'web_search'] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** Same shape governance requires of a project slug, for the same reason. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export interface ToolRef {
  readonly assetId: string;
  /** Null pins to whatever is published when the run starts. */
  readonly version: number | null;
}

export interface StoreRef {
  readonly storeId: string;
}

export interface AgentDefinition {
  readonly kind: 'agent';
  readonly instructions: string;
  readonly modelAlias: string;
  readonly tools: readonly ToolRef[];
  readonly knowledge: readonly StoreRef[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
}

export interface ToolDefinition {
  readonly kind: 'tool';
  readonly toolType: ToolType;
  readonly riskLevel: RiskLevel;
  readonly endpoint?: string;
  readonly builtinId?: BuiltinTool;
  readonly parameters?: Record<string, unknown>;
  /** Credentials live in a connection, never in the definition (ADR-015). */
  readonly connectionId?: string;
}

export interface PromptDefinition {
  readonly kind: 'prompt';
  readonly template: string;
  readonly variables: readonly string[];
}

export type AssetDefinition = AgentDefinition | ToolDefinition | PromptDefinition;

export function kindOf(definition: AssetDefinition): AssetKind {
  return definition.kind;
}

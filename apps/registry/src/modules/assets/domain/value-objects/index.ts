/** What an asset can be. A vector store is not here: aia-knowledge owns it (ADR-016). */
export const ASSET_KINDS = ['agent', 'tool', 'prompt'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const VERSION_STATUSES = ['draft', 'published', 'deprecated'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const TOOL_TYPES = ['mcp', 'openapi', 'function', 'builtin'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const BUILTIN_TOOLS = [
  'file_search',
  'code_interpreter',
  'web_search',
  'web_fetch',
  'current_time',
  'calculator',
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/**
 * The tools the platform provides in every project (ADR-024), which an agent
 * attaches by id with no asset behind it.
 *
 * aia-mcp-gateway owns and runs them; this list mirrors the ids its contract
 * publishes, so that publishing an agent can tell "a built-in" from "an asset
 * that was deleted" without a call back to the gateway -- which already calls
 * this service, and a cycle between the two would make each one's outage the
 * other's. `code_interpreter` is absent: nothing runs it yet.
 */
export const PLATFORM_TOOL_PREFIX = 'builtin.';
export const PLATFORM_TOOL_IDS: readonly string[] = [
  'web_search',
  'web_fetch',
  'current_time',
  'calculator',
  'file_search',
].map((builtinId) => `${PLATFORM_TOOL_PREFIX}${builtinId}`);

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

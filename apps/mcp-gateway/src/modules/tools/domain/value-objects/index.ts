export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const TOOL_TYPES = ['mcp', 'openapi', 'function', 'builtin'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

/**
 * A tool as the registry publishes it. This service does not own it -- it
 * reads it, and owns only whether a project may use it.
 */
export interface ToolDefinition {
  readonly toolId: string;
  /** The machine name a model is told to call. */
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly toolType: ToolType;
  readonly riskLevel: RiskLevel;
  readonly endpoint?: string;
  readonly builtinId?: string;
  readonly parameters?: Record<string, unknown>;
  readonly connectionId?: string;
}

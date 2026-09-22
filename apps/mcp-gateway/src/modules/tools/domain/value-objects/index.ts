export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const TOOL_TYPES = ['mcp', 'openapi', 'function', 'builtin'] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

/**
 * Where a definition comes from.
 *
 * `registry` is a tool somebody defined and published; it does nothing until a
 * project binds it. `platform` ships with this service and is allowed in every
 * project until the project switches it off (ADR-024).
 */
export const TOOL_SOURCES = ['registry', 'platform'] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

/**
 * Where a tool sends its arguments, in the zones `@aia/auth` already reasons
 * about. `local` never leaves the platform; `global` reaches a third party on
 * the public internet, which a confidential project does not allow (ADR-010).
 */
export const DATA_ZONES = ['local', 'global'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/**
 * A tool as the gateway runs it: read from the registry, or one of the
 * platform's own built-ins. This service owns neither a registry definition nor
 * the project's data -- only whether a project may use a tool.
 */
export interface ToolDefinition {
  readonly toolId: string;
  /** The machine name a model is told to call. */
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly toolType: ToolType;
  readonly source: ToolSource;
  readonly riskLevel: RiskLevel;
  readonly endpoint?: string;
  readonly builtinId?: string;
  readonly parameters?: Record<string, unknown>;
  readonly connectionId?: string;
  /**
   * Declared only by a built-in, whose destination the platform knows. A
   * registry tool reaches an endpoint an administrator chose deliberately.
   */
  readonly dataZone?: DataZone;
}

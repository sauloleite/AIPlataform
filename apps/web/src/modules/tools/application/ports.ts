/** The console's view of aia-mcp-gateway. */

export type RiskLevel = 'low' | 'medium' | 'high';
export type ToolType = 'mcp' | 'openapi' | 'function' | 'builtin';
/** `platform` ships with the platform and exists in every project (ADR-024). */
export type ToolSource = 'registry' | 'platform';

export interface EffectiveTool {
  toolId: string;
  /** The machine name a model is told to call. */
  slug: string;
  name: string;
  description?: string;
  toolType: ToolType;
  source: ToolSource;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  rateLimitPerMinute: number | null;
}

/** A built-in as its administrator sees it, including when it cannot run. */
export interface BuiltinTool {
  toolId: string;
  slug: string;
  name: string;
  description: string;
  builtinId: string;
  riskLevel: RiskLevel;
  /** `global` sends data to a third party on the public internet. */
  dataZone: 'local' | 'global';
  enabled: boolean;
  available: boolean;
  unavailableReason: string | null;
  requiresApproval: boolean;
  rateLimitPerMinute: number;
}

export type ConnectionKind = 'bearer' | 'api_key' | 'basic' | 'none';

/** A credential the platform presents. The value is never on this side. */
export interface ConnectionSummary {
  id: string;
  slug: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  header: string;
  secretRef: string;
  /** Whether the named secret is actually on the host right now. */
  resolved: boolean;
}

export interface CreateConnectionInput {
  slug: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  header?: string;
  secretRef?: string;
}

export interface Binding {
  toolId: string;
  enabled: boolean;
  rateLimitPerMinute: number | null;
  requireApproval: boolean | null;
}

export interface ToolsGateway {
  listConnections(accessToken: string, projectId: string): Promise<ConnectionSummary[]>;

  createConnection(
    accessToken: string,
    projectId: string,
    input: CreateConnectionInput,
  ): Promise<ConnectionSummary>;

  deleteConnection(accessToken: string, projectId: string, connectionId: string): Promise<void>;

  listEffective(accessToken: string, projectId: string): Promise<EffectiveTool[]>;
  listBuiltins(accessToken: string, projectId: string): Promise<BuiltinTool[]>;
  listBindings(accessToken: string, projectId: string): Promise<Binding[]>;
  bind(
    accessToken: string,
    projectId: string,
    toolId: string,
    input: { enabled: boolean; rateLimitPerMinute?: number; requireApproval?: boolean },
  ): Promise<Binding>;
  unbind(accessToken: string, projectId: string, toolId: string): Promise<void>;
}

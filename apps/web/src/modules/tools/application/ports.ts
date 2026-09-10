/** The console's view of aia-mcp-gateway. */

export type RiskLevel = 'low' | 'medium' | 'high';
export type ToolType = 'mcp' | 'openapi' | 'builtin';

export interface EffectiveTool {
  toolId: string;
  /** The machine name a model is told to call. */
  slug: string;
  name: string;
  description?: string;
  toolType: ToolType;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  rateLimitPerMinute: number | null;
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
  listBindings(accessToken: string, projectId: string): Promise<Binding[]>;
  bind(
    accessToken: string,
    projectId: string,
    toolId: string,
    input: { enabled: boolean; rateLimitPerMinute?: number; requireApproval?: boolean },
  ): Promise<Binding>;
  unbind(accessToken: string, projectId: string, toolId: string): Promise<void>;
}

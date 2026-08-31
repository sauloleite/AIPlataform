import type { ConnectionKind } from '../domain/entities/connection.js';
import type { RiskLevel, ToolType } from '../domain/value-objects/index.js';

export interface InvokeToolCommand {
  projectId: string;
  toolId: string;
  principalId: string;
  accessToken: string;
  arguments: Record<string, unknown>;
  /** Present on the second call, after a human approved. */
  approvalId?: string;
}

export interface BindToolCommand {
  projectId: string;
  toolId: string;
  accessToken: string;
  enabled?: boolean;
  rateLimitPerMinute?: number;
  requireApproval?: boolean;
}

export interface EffectiveToolView {
  toolId: string;
  slug: string;
  name: string;
  description?: string;
  toolType: ToolType;
  builtinId?: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  rateLimitPerMinute: number | null;
  parameters?: Record<string, unknown>;
}

export interface BindingView {
  projectId: string;
  toolId: string;
  enabled: boolean;
  rateLimitPerMinute: number | null;
  requireApproval: boolean | null;
  updatedAt: string;
}

export interface InvocationResultView {
  toolId: string;
  status: 'ok';
  result: unknown;
  durationMs: number;
}

export interface CreateConnectionCommand {
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  header?: string;
  /** A NAME, never a value. Absent only when the kind is `none`. */
  secretRef?: string;
}

export interface ConnectionView {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  kind: ConnectionKind;
  header: string;
  secretRef: string;
  /** Whether the named secret is actually there right now. */
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

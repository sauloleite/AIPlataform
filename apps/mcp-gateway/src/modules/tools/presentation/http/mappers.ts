import type {
  BindingView,
  ConnectionView,
  EffectiveToolView,
  InvocationResultView,
} from '../../application/dto.js';

/**
 * Application views translated into the shape the contract publishes.
 *
 * The application layer names things the way the language does; the wire is
 * snake_case because `contracts/openapi/mcp-gateway.v1.yaml` says so, and the
 * contract is the source. Serialising a view straight out of a controller ties
 * an external API to an internal field name — rename the field and every client
 * breaks.
 */

export function toEffectiveToolResponse(tool: EffectiveToolView): Record<string, unknown> {
  return {
    tool_id: tool.toolId,
    slug: tool.slug,
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    tool_type: tool.toolType,
    ...(tool.builtinId !== undefined && { builtin_id: tool.builtinId }),
    risk_level: tool.riskLevel,
    requires_approval: tool.requiresApproval,
    rate_limit_per_minute: tool.rateLimitPerMinute,
    ...(tool.parameters !== undefined && { parameters: tool.parameters }),
  };
}

export function toBindingResponse(binding: BindingView): Record<string, unknown> {
  return {
    project_id: binding.projectId,
    tool_id: binding.toolId,
    enabled: binding.enabled,
    rate_limit_per_minute: binding.rateLimitPerMinute,
    require_approval: binding.requireApproval,
    updated_at: binding.updatedAt,
  };
}

export function toInvocationResponse(result: InvocationResultView): Record<string, unknown> {
  return {
    tool_id: result.toolId,
    status: result.status,
    result: result.result,
    duration_ms: result.durationMs,
  };
}

/**
 * A connection on the wire.
 *
 * There is no branch here that could emit a secret, because `ConnectionView`
 * has no field holding one. The mapper cannot leak what it was never given.
 */
export function toConnectionResponse(connection: ConnectionView): Record<string, unknown> {
  return {
    id: connection.id,
    project_id: connection.projectId,
    slug: connection.slug,
    name: connection.name,
    ...(connection.description !== undefined && { description: connection.description }),
    kind: connection.kind,
    header: connection.header,
    secret_ref: connection.secretRef,
    resolved: connection.resolved,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt,
  };
}

/**
 * Whether a tool call may run, and whether a human has to approve it first.
 *
 * The authorisation half composes the platform's existing specifications
 * rather than restating them: `isMemberOfProject` is the tenancy rule,
 * `canInvokeToolRisk` is OWASP LLM06 and `dataZoneIsCompatible` is ADR-010, as
 * `@aia/auth` already expresses them. Only the approval question and the
 * built-in default are new, and they live here because they are pure rules
 * about risk and configuration -- no clock, no store, no HTTP.
 */
import {
  POLICY,
  canInvokeToolRisk,
  dataZoneIsCompatible,
  isMemberOfProject,
  type Principal,
} from '@aia/auth';

import { DEFAULT_RATE_LIMIT_PER_MINUTE, type ToolBinding } from '../entities/tool-binding.js';
import { ToolNotAllowedError } from '../errors/index.js';
import type { RiskLevel, ToolDefinition } from '../value-objects/index.js';

/** Membership AND the risk-level role, in one rule. */
export const MAY_INVOKE = isMemberOfProject.and(canInvokeToolRisk);

export interface InvocationDecision {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reason: string;
}

/**
 * Whether the project allows the tool at all, before who is asking matters.
 *
 * A built-in ships with the platform and is allowed until the project says
 * otherwise (ADR-024). A registry tool is somebody's endpoint, and does nothing
 * until a project binds it (reference doc 02 §3).
 */
export function isAllowedInProject(tool: ToolDefinition, binding: ToolBinding | null): boolean {
  if (binding !== null) return binding.enabled;
  return tool.source === 'platform';
}

/** The binding's own rate, or the platform default when there is no binding. */
export function rateLimitFor(binding: ToolBinding | null): number {
  return binding?.effectiveRateLimit ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
}

/**
 * Why a tool may not send its arguments where it sends them, or null.
 *
 * Only a tool that declares a zone beyond the platform is asked. An unknown
 * classification refuses: `dataZoneIsCompatible` lets an ABSENT classification
 * through, which is right for a request that carries none and wrong for a tool
 * that needed one and could not get it (reference doc 02 §10, fail closed).
 */
export function dataZoneRefusal(input: {
  principal: Principal;
  projectId: string;
  tool: ToolDefinition;
  dataClassification: string | undefined;
}): string | null {
  const { tool, dataClassification } = input;
  if (tool.dataZone === undefined || tool.dataZone === 'local') return null;

  if (dataClassification === undefined) {
    return (
      'This tool sends data outside the platform, and the project classification that ' +
      'would allow it could not be confirmed'
    );
  }

  const decision = dataZoneIsCompatible.evaluate({
    principal: input.principal,
    projectId: input.projectId,
    dataClassification,
    targetDataZone: tool.dataZone,
  });
  return decision.allowed
    ? null
    : `This tool sends data outside the platform, which a ${dataClassification} project does not allow`;
}

/**
 * Decides, without running anything.
 *
 * Throws rather than returning `allowed: false` for the cases the caller can
 * do nothing about -- an unbound tool is a configuration answer, not a
 * retryable one. Approval is returned rather than thrown because it IS
 * actionable: a human approves and the same call proceeds.
 */
export function decideInvocation(input: {
  principal: Principal;
  projectId: string;
  tool: ToolDefinition;
  binding: ToolBinding | null;
  /** The project's classification. Needed only by a tool that leaves the platform. */
  dataClassification?: string;
}): InvocationDecision {
  const { principal, projectId, tool, binding } = input;

  if (!isAllowedInProject(tool, binding)) {
    throw new ToolNotAllowedError(
      tool.toolId,
      binding === null
        ? 'This tool is not allowed in this project. Bind it first.'
        : 'This tool is switched off in this project',
    );
  }

  const decision = MAY_INVOKE.evaluate({
    principal,
    projectId,
    toolRiskLevel: tool.riskLevel,
  });
  if (!decision.allowed) {
    throw new ToolNotAllowedError(tool.toolId, decision.reason);
  }

  const zone = dataZoneRefusal({
    principal,
    projectId,
    tool,
    dataClassification: input.dataClassification,
  });
  if (zone !== null) throw new ToolNotAllowedError(tool.toolId, zone);

  return {
    allowed: true,
    requiresApproval: requiresApproval(tool.riskLevel, binding),
    reason: decision.reason,
  };
}

/**
 * A binding may RAISE the bar, never lower it.
 *
 * `require_approval: false` on a high-risk tool is a configuration mistake
 * waiting to become an incident, so it is ignored rather than honoured.
 */
export function requiresApproval(riskLevel: RiskLevel, binding: ToolBinding | null): boolean {
  if (riskLevel === 'high') return true;
  return binding?.requireApproval === true;
}

export { POLICY };

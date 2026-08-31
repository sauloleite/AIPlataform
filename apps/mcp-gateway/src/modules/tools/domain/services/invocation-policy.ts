/**
 * Whether a tool call may run, and whether a human has to approve it first.
 *
 * The authorisation half composes the platform's existing specifications
 * rather than restating them: `isMemberOfProject` is the tenancy rule and
 * `canInvokeToolRisk` is OWASP LLM06 as `@aia/auth` already expresses it.
 * Only the approval question is new, and it lives here because it is a pure
 * rule about risk and configuration -- no clock, no store, no HTTP.
 */
import { POLICY, canInvokeToolRisk, isMemberOfProject, type Principal } from '@aia/auth';

import type { ToolBinding } from '../entities/tool-binding.js';
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
}): InvocationDecision {
  const { principal, projectId, tool, binding } = input;

  if (binding === null) {
    throw new ToolNotAllowedError(
      tool.toolId,
      'This tool is not allowed in this project. Bind it first.',
    );
  }
  if (!binding.enabled) {
    throw new ToolNotAllowedError(tool.toolId, 'This tool is switched off in this project');
  }

  const decision = MAY_INVOKE.evaluate({
    principal,
    projectId,
    toolRiskLevel: tool.riskLevel,
  });
  if (!decision.allowed) {
    throw new ToolNotAllowedError(tool.toolId, decision.reason);
  }

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
export function requiresApproval(riskLevel: RiskLevel, binding: ToolBinding): boolean {
  if (riskLevel === 'high') return true;
  return binding.requireApproval === true;
}

export { POLICY };

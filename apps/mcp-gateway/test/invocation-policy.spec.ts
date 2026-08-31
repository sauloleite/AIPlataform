import { describe, expect, it } from 'vitest';
import type { Principal } from '@aia/auth';

import { ToolBinding } from '../src/modules/tools/domain/entities/tool-binding.js';
import { ToolNotAllowedError } from '../src/modules/tools/domain/errors/index.js';
import {
  decideInvocation,
  requiresApproval,
} from '../src/modules/tools/domain/services/invocation-policy.js';
import type { RiskLevel, ToolDefinition } from '../src/modules/tools/domain/value-objects/index.js';

const NOW = new Date('2026-08-27T00:00:00Z');
const PROJECT = 'p1';

function principal(roles: string[], projectId = PROJECT): Principal {
  return {
    id: 'user-1',
    type: 'user',
    scopes: [],
    globalRoles: [],
    memberships: [{ projectId, roles }],
  } as unknown as Principal;
}

function tool(riskLevel: RiskLevel): ToolDefinition {
  return { toolId: 't1', slug: 'ticket-lookup', name: 'Ticket lookup', toolType: 'mcp', riskLevel };
}

function binding(overrides: Partial<Parameters<typeof ToolBinding.create>[0]> = {}): ToolBinding {
  return ToolBinding.create({ projectId: PROJECT, toolId: 't1', now: NOW, ...overrides });
}

const MEMBER = principal(['project_viewer']);
const OWNER = principal(['project_owner']);

describe('the allow-list', () => {
  // A tool published in the registry is not usable until a project binds it.
  it('refuses a tool that was never bound', () => {
    expect(() =>
      decideInvocation({ principal: OWNER, projectId: PROJECT, tool: tool('low'), binding: null }),
    ).toThrow(ToolNotAllowedError);
  });

  it('refuses a tool that is bound but switched off', () => {
    expect(() =>
      decideInvocation({
        principal: OWNER,
        projectId: PROJECT,
        tool: tool('low'),
        binding: binding({ enabled: false }),
      }),
    ).toThrow(ToolNotAllowedError);
  });

  it('allows a bound, enabled tool for a member', () => {
    const decision = decideInvocation({
      principal: MEMBER,
      projectId: PROJECT,
      tool: tool('low'),
      binding: binding(),
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('tenancy', () => {
  // The binding is per project; a principal outside it is refused even when
  // the tool is bound, because the membership rule runs first.
  it('refuses a principal who does not belong to the project', () => {
    expect(() =>
      decideInvocation({
        principal: principal(['project_owner'], 'another-project'),
        projectId: PROJECT,
        tool: tool('low'),
        binding: binding(),
      }),
    ).toThrow(ToolNotAllowedError);
  });
});

describe('OWASP LLM06: excessive agency', () => {
  it('refuses a high-risk tool to somebody without an elevated role', () => {
    expect(() =>
      decideInvocation({
        principal: MEMBER,
        projectId: PROJECT,
        tool: tool('high'),
        binding: binding(),
      }),
    ).toThrow(ToolNotAllowedError);
  });

  it('always demands approval for a high-risk tool, even from an owner', () => {
    const decision = decideInvocation({
      principal: OWNER,
      projectId: PROJECT,
      tool: tool('high'),
      binding: binding(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  /**
   * The rule that matters: a binding may RAISE the bar, never lower it.
   * `require_approval: false` on a high-risk tool is a configuration mistake
   * waiting to become an incident.
   */
  it('ignores a binding that tries to waive approval on a high-risk tool', () => {
    expect(requiresApproval('high', binding({ requireApproval: false }))).toBe(true);
  });

  it('lets a binding demand approval for a tool that would not need it', () => {
    expect(requiresApproval('low', binding({ requireApproval: true }))).toBe(true);
    expect(requiresApproval('medium', binding({ requireApproval: true }))).toBe(true);
  });

  it('runs a low-risk tool without approval by default', () => {
    expect(requiresApproval('low', binding())).toBe(false);
    expect(requiresApproval('medium', binding())).toBe(false);
  });
});

describe('rate limits', () => {
  it('falls back to the platform default when the binding names none', () => {
    expect(binding().effectiveRateLimit).toBe(60);
  });

  it('uses the binding’s own rate when it has one', () => {
    expect(binding({ rateLimitPerMinute: 5 }).effectiveRateLimit).toBe(5);
  });

  it('refuses a nonsensical rate at construction', () => {
    expect(() => binding({ rateLimitPerMinute: 0 })).toThrow();
    expect(() => binding({ rateLimitPerMinute: 1.5 })).toThrow();
  });
});

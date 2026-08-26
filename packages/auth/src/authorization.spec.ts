import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@aia/errors';
import {
  POLICY,
  authorize,
  canInvokeToolRisk,
  dataZoneIsCompatible,
  hasRole,
  hasScope,
  isMemberOfProject,
  type AccessRequest,
} from './authorization.js';
import { ROLES, type Principal } from './principal.js';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'user-1',
    type: 'user',
    globalRoles: [],
    memberships: [{ projectId: 'proj-1', roles: [ROLES.PROJECT_VIEWER] }],
    scopes: ['inference:read'],
    issuer: 'http://identity',
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

const request = (overrides: Partial<AccessRequest> = {}): AccessRequest => ({
  principal: principal(),
  projectId: 'proj-1',
  ...overrides,
});

describe('isMemberOfProject', () => {
  it('allows a project member', () => {
    expect(isMemberOfProject.isSatisfiedBy(request())).toBe(true);
  });

  it('denies someone who does not belong to the project', () => {
    expect(isMemberOfProject.isSatisfiedBy(request({ projectId: 'proj-other' }))).toBe(false);
  });

  it('platform_admin passes on any project', () => {
    const admin = principal({ globalRoles: [ROLES.PLATFORM_ADMIN], memberships: [] });
    expect(
      isMemberOfProject.isSatisfiedBy(request({ principal: admin, projectId: 'anything' })),
    ).toBe(true);
  });
});

describe('hasRole', () => {
  it('accepts any of the listed roles', () => {
    expect(hasRole(ROLES.PROJECT_OWNER, ROLES.PROJECT_VIEWER).isSatisfiedBy(request())).toBe(true);
  });

  it('denies when the principal holds none of them', () => {
    const decision = hasRole(ROLES.PROJECT_OWNER).evaluate(request());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('project_owner');
  });
});

describe('dataZoneIsCompatible (ADR-010)', () => {
  it('a restricted project only routes to the local zone', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'restricted', targetDataZone: 'local' }),
      ),
    ).toBe(true);
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'restricted', targetDataZone: 'us' }),
      ),
    ).toBe(false);
  });

  it('a confidential project does not leave the country', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'confidential', targetDataZone: 'br' }),
      ),
    ).toBe(true);
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'confidential', targetDataZone: 'global' }),
      ),
    ).toBe(false);
  });

  it('an internal project may use an external provider', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'internal', targetDataZone: 'us' }),
      ),
    ).toBe(true);
  });

  it('an unknown classification fails closed', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'made-up', targetDataZone: 'local' }),
      ),
    ).toBe(false);
  });
});

describe('specification composition', () => {
  it('and requires both and returns the reason of whichever denied', () => {
    const combined = isMemberOfProject.and(dataZoneIsCompatible);
    const decision = combined.evaluate(
      request({ dataClassification: 'restricted', targetDataZone: 'us' }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('data zone');
  });

  it('or accepts either', () => {
    const combined = hasRole(ROLES.PROJECT_OWNER).or(hasScope('inference:read'));
    expect(combined.isSatisfiedBy(request())).toBe(true);
  });

  it('not inverts', () => {
    expect(hasRole(ROLES.PROJECT_OWNER).not().isSatisfiedBy(request())).toBe(true);
  });

  it('the composed name describes the whole rule, for the trace', () => {
    expect(isMemberOfProject.and(dataZoneIsCompatible).name).toBe(
      '(is a member of the project and data zone compatible with the classification)',
    );
  });
});

describe('canInvokeToolRisk (OWASP LLM06)', () => {
  it('a low-risk tool needs no elevated role', () => {
    expect(canInvokeToolRisk.isSatisfiedBy(request({ toolRiskLevel: 'low' }))).toBe(true);
  });

  it('a high-risk tool requires the project owner', () => {
    expect(canInvokeToolRisk.isSatisfiedBy(request({ toolRiskLevel: 'high' }))).toBe(false);

    const owner = principal({
      memberships: [{ projectId: 'proj-1', roles: [ROLES.PROJECT_OWNER] }],
    });
    expect(
      canInvokeToolRisk.isSatisfiedBy(request({ principal: owner, toolRiskLevel: 'high' })),
    ).toBe(true);
  });
});

describe('authorize', () => {
  it('returns the rule and reason so they can be recorded in the trace', () => {
    expect(authorize(POLICY.READ_PROJECT, request())).toEqual({
      rule: 'is a member of the project',
      reason: 'is a member of the project',
    });
  });

  it('throws ForbiddenError carrying the rule that denied', () => {
    try {
      authorize(POLICY.MANAGE_BUDGET, request());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).details['rule']).toContain('project_owner');
      expect((error as ForbiddenError).details['project_id']).toBe('proj-1');
    }
  });
});

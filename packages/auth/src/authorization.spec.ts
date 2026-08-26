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
  it('permite membro do projeto', () => {
    expect(isMemberOfProject.isSatisfiedBy(request())).toBe(true);
  });

  it('nega quem nao pertence ao projeto', () => {
    expect(isMemberOfProject.isSatisfiedBy(request({ projectId: 'proj-outro' }))).toBe(false);
  });

  it('platform_admin passa em qualquer projeto', () => {
    const admin = principal({ globalRoles: [ROLES.PLATFORM_ADMIN], memberships: [] });
    expect(
      isMemberOfProject.isSatisfiedBy(request({ principal: admin, projectId: 'qualquer' })),
    ).toBe(true);
  });
});

describe('hasRole', () => {
  it('aceita qualquer um dos papeis listados', () => {
    expect(hasRole(ROLES.PROJECT_OWNER, ROLES.PROJECT_VIEWER).isSatisfiedBy(request())).toBe(true);
  });

  it('nega quando o principal nao tem nenhum deles', () => {
    const decision = hasRole(ROLES.PROJECT_OWNER).evaluate(request());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('project_owner');
  });
});

describe('dataZoneIsCompatible (ADR-010)', () => {
  it('projeto restrito so roteia para zona local', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'restrito', targetDataZone: 'local' }),
      ),
    ).toBe(true);
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'restrito', targetDataZone: 'us' }),
      ),
    ).toBe(false);
  });

  it('projeto confidencial nao sai do pais', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'confidencial', targetDataZone: 'br' }),
      ),
    ).toBe(true);
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'confidencial', targetDataZone: 'global' }),
      ),
    ).toBe(false);
  });

  it('projeto interno pode usar provedor externo', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'interno', targetDataZone: 'us' }),
      ),
    ).toBe(true);
  });

  it('classificacao desconhecida falha fechado', () => {
    expect(
      dataZoneIsCompatible.isSatisfiedBy(
        request({ dataClassification: 'inventada', targetDataZone: 'local' }),
      ),
    ).toBe(false);
  });
});

describe('composicao de especificacoes', () => {
  it('and exige as duas e devolve o motivo de quem negou', () => {
    const combined = isMemberOfProject.and(dataZoneIsCompatible);
    const decision = combined.evaluate(
      request({ dataClassification: 'restrito', targetDataZone: 'us' }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('zona de dados');
  });

  it('or aceita qualquer uma', () => {
    const combined = hasRole(ROLES.PROJECT_OWNER).or(hasScope('inference:read'));
    expect(combined.isSatisfiedBy(request())).toBe(true);
  });

  it('not inverte', () => {
    expect(hasRole(ROLES.PROJECT_OWNER).not().isSatisfiedBy(request())).toBe(true);
  });

  it('o nome composto descreve a regra inteira, para o trace', () => {
    expect(isMemberOfProject.and(dataZoneIsCompatible).name).toBe(
      '(e membro do projeto and zona de dados compativel com a classificacao)',
    );
  });
});

describe('canInvokeToolRisk (OWASP LLM06)', () => {
  it('tool de risco baixo nao exige papel elevado', () => {
    expect(canInvokeToolRisk.isSatisfiedBy(request({ toolRiskLevel: 'low' }))).toBe(true);
  });

  it('tool de risco alto exige dono do projeto', () => {
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
  it('devolve a regra e o motivo para registrar no trace', () => {
    expect(authorize(POLICY.READ_PROJECT, request())).toEqual({
      rule: 'e membro do projeto',
      reason: 'e membro do projeto',
    });
  });

  it('lanca ForbiddenError carregando a regra que negou', () => {
    try {
      authorize(POLICY.MANAGE_BUDGET, request());
      expect.unreachable('deveria ter lancado');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).details['rule']).toContain('project_owner');
      expect((error as ForbiddenError).details['project_id']).toBe('proj-1');
    }
  });
});

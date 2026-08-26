import { ForbiddenError } from '@aia/errors';
import { ROLES, type Principal, type Role, isPlatformAdmin, rolesInProject } from './principal.js';
import { Specification, allow, deny, spec } from './specification.js';

/** O que esta sendo autorizado: um principal agindo sobre um projeto. */
export interface AccessRequest {
  principal: Principal;
  projectId: string;
  /** Classificacao de dados do projeto, para as regras ABAC. */
  dataClassification?: string;
  /** Zona de dados do recurso alvo (ex.: onde o modelo roda). */
  targetDataZone?: string;
  /** Nivel de risco da tool sendo invocada. */
  toolRiskLevel?: 'low' | 'medium' | 'high';
}

class HasRoleInProject extends Specification<AccessRequest> {
  readonly name: string;

  constructor(private readonly roles: readonly Role[]) {
    super();
    this.name = `tem um dos papeis [${roles.join(', ')}]`;
  }

  evaluate(request: AccessRequest): ReturnType<Specification<AccessRequest>['evaluate']> {
    if (isPlatformAdmin(request.principal)) return allow('platform_admin');
    const granted = rolesInProject(request.principal, request.projectId);
    const match = this.roles.find((role) => granted.includes(role));
    return match === undefined
      ? deny(`principal nao tem ${this.roles.join(' nem ')} no projeto`)
      : allow(`papel ${match}`);
  }
}

export const hasRole = (...roles: Role[]): Specification<AccessRequest> =>
  new HasRoleInProject(roles);

export const isMemberOfProject = spec<AccessRequest>(
  'e membro do projeto',
  (request) =>
    isPlatformAdmin(request.principal) ||
    request.principal.memberships.some((m) => m.projectId === request.projectId),
  'principal nao pertence ao projeto',
);

export const hasScope = (scope: string): Specification<AccessRequest> =>
  spec(
    `tem o escopo ${scope}`,
    (request) => request.principal.scopes.includes(scope) || request.principal.scopes.includes('*'),
    `token nao carrega o escopo ${scope}`,
  );

/**
 * ABAC do ADR-010: dado classificado so pode ir para uma zona compativel.
 *
 * A ordem importa: `restrito` so aceita `local`, `confidencial` aceita `local`,
 * e assim por diante. Um dado publico pode ir para qualquer lugar.
 */
const ZONES_BY_CLASSIFICATION: Record<string, readonly string[]> = {
  publico: ['local', 'br', 'us', 'eu', 'global'],
  interno: ['local', 'br', 'us', 'eu', 'global'],
  confidencial: ['local', 'br'],
  restrito: ['local'],
};

export const dataZoneIsCompatible = spec<AccessRequest>(
  'zona de dados compativel com a classificacao',
  (request) => {
    if (request.dataClassification === undefined || request.targetDataZone === undefined) {
      return true;
    }
    const allowed = ZONES_BY_CLASSIFICATION[request.dataClassification];
    // Classificacao desconhecida e negada: falhar fechado (doc 02, secao 10).
    return allowed?.includes(request.targetDataZone) === true;
  },
  'a zona de dados do destino nao e compativel com a classificacao do projeto',
);

/** OWASP LLM06: tool de risco alto exige papel de dono ou admin. */
export const canInvokeToolRisk = new (class extends Specification<AccessRequest> {
  readonly name = 'pode invocar tool no nivel de risco';

  evaluate(request: AccessRequest): ReturnType<Specification<AccessRequest>['evaluate']> {
    if (request.toolRiskLevel !== 'high') return allow('risco nao exige papel elevado');
    return hasRole(ROLES.PROJECT_OWNER).evaluate(request);
  }
})();

/** Politicas prontas para os casos mais comuns. */
export const POLICY = {
  READ_PROJECT: isMemberOfProject,
  USE_INFERENCE: isMemberOfProject.and(dataZoneIsCompatible),
  EDIT_ASSETS: hasRole(ROLES.PROJECT_OWNER, ROLES.PROJECT_EDITOR),
  MANAGE_BUDGET: hasRole(ROLES.PROJECT_OWNER),
  READ_AUDIT: hasRole(ROLES.PROJECT_OWNER, ROLES.AUDITOR),
} as const;

/**
 * Aplica uma especificacao e lanca se negar.
 *
 * A decisao (nome da regra e motivo) e devolvida para que quem chama registre
 * no trace: doc 02, secao 6, exige decisao de autorizacao rastreavel.
 */
export function authorize(
  specification: Specification<AccessRequest>,
  request: AccessRequest,
): { rule: string; reason: string } {
  const decision = specification.evaluate(request);
  if (!decision.allowed) {
    throw new ForbiddenError(decision.reason, {
      rule: specification.name,
      project_id: request.projectId,
    });
  }
  return { rule: specification.name, reason: decision.reason };
}

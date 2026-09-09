import { MAX_ZONES_BY_CLASSIFICATION } from '@aia/contracts';
import { ForbiddenError } from '@aia/errors';
import { ROLES, type Principal, type Role, isPlatformAdmin, rolesInProject } from './principal.js';
import { Specification, allow, deny, spec } from './specification.js';

/** What is being authorised: a principal acting on a project. */
export interface AccessRequest {
  principal: Principal;
  projectId: string;
  /** The project's data classification, for the ABAC rules. */
  dataClassification?: string;
  /** Data zone of the target resource, e.g. where the model runs. */
  targetDataZone?: string;
  /** Risk level of the tool being invoked. */
  toolRiskLevel?: 'low' | 'medium' | 'high';
}

class HasRoleInProject extends Specification<AccessRequest> {
  readonly name: string;

  constructor(private readonly roles: readonly Role[]) {
    super();
    this.name = `has one of the roles [${roles.join(', ')}]`;
  }

  evaluate(request: AccessRequest): ReturnType<Specification<AccessRequest>['evaluate']> {
    if (isPlatformAdmin(request.principal)) return allow('platform_admin');
    const granted = rolesInProject(request.principal, request.projectId);
    const match = this.roles.find((role) => granted.includes(role));
    return match === undefined
      ? deny(`principal has none of ${this.roles.join(', ')} on the project`)
      : allow(`role ${match}`);
  }
}

export const hasRole = (...roles: Role[]): Specification<AccessRequest> =>
  new HasRoleInProject(roles);

export const isMemberOfProject = spec<AccessRequest>(
  'is a member of the project',
  (request) =>
    isPlatformAdmin(request.principal) ||
    request.principal.memberships.some((m) => m.projectId === request.projectId),
  'principal does not belong to the project',
);

export const hasScope = (scope: string): Specification<AccessRequest> =>
  spec(
    `has the ${scope} scope`,
    (request) => request.principal.scopes.includes(scope) || request.principal.scopes.includes('*'),
    `token does not carry the ${scope} scope`,
  );

/**
 * The ABAC rule behind ADR-010: classified data may only reach a compatible
 * zone.
 *
 * The order matters: `restricted` accepts only `local`, `confidential` also
 * accepts in-country, and so on. Public data may go anywhere.
 *
 * Read from the contract rather than written here (ADR-027). The same table
 * used to exist in this file, in `python/aia_auth`, in aia-governance's domain
 * and in the console's, and nothing compared the four.
 */
const ZONES_BY_CLASSIFICATION: Record<string, readonly string[]> = MAX_ZONES_BY_CLASSIFICATION;

export const dataZoneIsCompatible = spec<AccessRequest>(
  'data zone compatible with the classification',
  (request) => {
    if (request.dataClassification === undefined || request.targetDataZone === undefined) {
      return true;
    }
    const allowed = ZONES_BY_CLASSIFICATION[request.dataClassification];
    // An unknown classification is denied: fail closed (reference doc 02 §10).
    return allowed?.includes(request.targetDataZone) === true;
  },
  "the target's data zone is not compatible with the project classification",
);

/** OWASP LLM06: a high-risk tool requires an owner or admin role. */
export const canInvokeToolRisk = new (class extends Specification<AccessRequest> {
  readonly name = 'may invoke a tool at this risk level';

  evaluate(request: AccessRequest): ReturnType<Specification<AccessRequest>['evaluate']> {
    if (request.toolRiskLevel !== 'high') return allow('risk level needs no elevated role');
    return hasRole(ROLES.PROJECT_OWNER).evaluate(request);
  }
})();

/** Ready-made policies for the common cases. */
export const POLICY = {
  READ_PROJECT: isMemberOfProject,
  USE_INFERENCE: isMemberOfProject.and(dataZoneIsCompatible),
  EDIT_ASSETS: hasRole(ROLES.PROJECT_OWNER, ROLES.PROJECT_EDITOR),
  MANAGE_BUDGET: hasRole(ROLES.PROJECT_OWNER),
  READ_AUDIT: hasRole(ROLES.PROJECT_OWNER, ROLES.AUDITOR),
} as const;

/**
 * Applies a specification and throws if it denies.
 *
 * The decision (rule name and reason) is returned so the caller can record it in
 * the trace: reference doc 02 §6 requires an auditable authorisation decision.
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

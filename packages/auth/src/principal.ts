/**
 * Who is calling. Three kinds of principal (reference doc 02 §6): a user, an
 * application (client credentials or PAT), and a service (internal call).
 */
export type PrincipalType = 'user' | 'application' | 'service';

/** Platform roles (RBAC). ABAC covers whatever depends on an attribute. */
export const ROLES = {
  /** Administers the whole platform. */
  PLATFORM_ADMIN: 'platform_admin',
  /** Owns a project: budget, members, policies. */
  PROJECT_OWNER: 'project_owner',
  /** Creates and edits assets inside the project. */
  PROJECT_EDITOR: 'project_editor',
  /** Consumes and reads only. */
  PROJECT_VIEWER: 'project_viewer',
  /** Reads audit and usage across every project, changing nothing. */
  AUDITOR: 'auditor',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** A principal's membership in a project. Project is the tenant. */
export interface ProjectMembership {
  projectId: string;
  roles: Role[];
}

export interface Principal {
  id: string;
  type: PrincipalType;
  /** Absent for principals that are not people. */
  email?: string;
  displayName?: string;
  /** Roles valid platform-wide, independent of any project. */
  globalRoles: Role[];
  memberships: ProjectMembership[];
  /** OAuth scopes on the token. They narrow what this token may do. */
  scopes: string[];
  /** Issuer that signed the token, for audit. */
  issuer: string;
  expiresAt: Date;
}

export function rolesInProject(principal: Principal, projectId: string): Role[] {
  const membership = principal.memberships.find((m) => m.projectId === projectId);
  return [...principal.globalRoles, ...(membership?.roles ?? [])];
}

export function isPlatformAdmin(principal: Principal): boolean {
  return principal.globalRoles.includes(ROLES.PLATFORM_ADMIN);
}

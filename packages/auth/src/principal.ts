/**
 * Quem esta chamando. Tres tipos de principal (doc 02, secao 6):
 * usuario, aplicacao (client credentials ou PAT) e servico (chamada interna).
 */
export type PrincipalType = 'user' | 'application' | 'service';

/** Papeis de plataforma (RBAC). ABAC cuida do que depende de atributo. */
export const ROLES = {
  /** Administra a plataforma inteira. */
  PLATFORM_ADMIN: 'platform_admin',
  /** Dono de um projeto: orcamento, membros, politicas. */
  PROJECT_OWNER: 'project_owner',
  /** Cria e altera ativos dentro do projeto. */
  PROJECT_EDITOR: 'project_editor',
  /** So consome e le. */
  PROJECT_VIEWER: 'project_viewer',
  /** Le auditoria e consumo de todos os projetos, sem alterar nada. */
  AUDITOR: 'auditor',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Vinculo de um principal com um projeto. Projeto e o tenant. */
export interface ProjectMembership {
  projectId: string;
  roles: Role[];
}

export interface Principal {
  id: string;
  type: PrincipalType;
  /** Ausente para principais que nao sao pessoas. */
  email?: string;
  displayName?: string;
  /** Papeis validos em toda a plataforma, independentes de projeto. */
  globalRoles: Role[];
  memberships: ProjectMembership[];
  /** Escopos do token (OAuth). Restringem o que aquele token pode fazer. */
  scopes: string[];
  /** Emissor que assinou o token, para auditoria. */
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

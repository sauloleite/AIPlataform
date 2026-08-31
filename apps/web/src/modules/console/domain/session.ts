/**
 * The signed-in session, as the console understands it.
 *
 * The console never parses the JWT: it is opaque here on purpose. What the
 * browser needs to render a menu is the principal's identity and roles, and the
 * server hands those over separately. Decoding a token client-side invites
 * trusting its claims, and the only place a claim may be trusted is behind the
 * signature check the platform already performs.
 */
export interface ProjectMembership {
  projectId: string;
  roles: string[];
}

export interface Principal {
  id: string;
  type: string;
  email?: string;
  displayName?: string;
  globalRoles: string[];
  memberships: ProjectMembership[];
}

export interface Session {
  principal: Principal;
  /** Unix seconds. Used only to sign out early, never to authorise anything. */
  expiresAt: number;
}

export const PLATFORM_ADMIN = 'platform_admin';
export const PROJECT_OWNER = 'project_owner';
export const PROJECT_EDITOR = 'project_editor';

export function isExpired(session: Session, nowSeconds: number): boolean {
  return session.expiresAt <= nowSeconds;
}

export function rolesIn(principal: Principal, projectId: string): string[] {
  const membership = principal.memberships.find((entry) => entry.projectId === projectId);
  return membership === undefined
    ? [...principal.globalRoles]
    : [...principal.globalRoles, ...membership.roles];
}

/**
 * Whether the console should OFFER the budget and policy controls.
 *
 * This hides a control the principal cannot use; it does not protect anything.
 * The platform authorises every write on its own, and a console that only hid
 * the button would be a console with no access control at all.
 */
export function canAdministerProject(principal: Principal, projectId: string): boolean {
  const roles = rolesIn(principal, projectId);
  return roles.includes(PLATFORM_ADMIN) || roles.includes(PROJECT_OWNER);
}

/**
 * Whether the console should OFFER the asset editing controls.
 *
 * Mirrors POLICY.EDIT_ASSETS in @aia/auth. Like the others here, it only hides
 * a control -- the registry authorises every write itself.
 */
export function canEditAssets(principal: Principal, projectId: string): boolean {
  const roles = rolesIn(principal, projectId);
  return (
    roles.includes(PLATFORM_ADMIN) ||
    roles.includes(PROJECT_OWNER) ||
    roles.includes(PROJECT_EDITOR)
  );
}

export function canCreateProject(principal: Principal): boolean {
  return principal.globalRoles.includes(PLATFORM_ADMIN);
}

export function displayNameOf(principal: Principal): string {
  return principal.displayName ?? principal.email ?? principal.id;
}

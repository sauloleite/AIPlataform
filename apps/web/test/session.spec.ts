import { describe, expect, it } from 'vitest';
import {
  canAdministerProject,
  canCreateProject,
  displayNameOf,
  isExpired,
  rolesIn,
} from '../src/modules/console/domain/session';
import type { Principal } from '../src/modules/console/domain/session';

function aPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'user-1',
    type: 'user',
    globalRoles: [],
    memberships: [],
    ...overrides,
  };
}

describe('session', () => {
  it('treats a session as expired at the exact second it expires', () => {
    const session = { principal: aPrincipal(), expiresAt: 1000 };
    expect(isExpired(session, 999)).toBe(false);
    expect(isExpired(session, 1000)).toBe(true);
  });

  it('combines global roles with the roles held in a project', () => {
    const principal = aPrincipal({
      globalRoles: ['auditor'],
      memberships: [{ projectId: 'proj-1', roles: ['project_editor'] }],
    });

    expect(rolesIn(principal, 'proj-1')).toEqual(['auditor', 'project_editor']);
    expect(rolesIn(principal, 'proj-2')).toEqual(['auditor']);
  });

  it('offers the admin controls to an owner of that project only', () => {
    const owner = aPrincipal({
      memberships: [
        { projectId: 'proj-1', roles: ['project_owner'] },
        { projectId: 'proj-2', roles: ['project_viewer'] },
      ],
    });

    expect(canAdministerProject(owner, 'proj-1')).toBe(true);
    expect(canAdministerProject(owner, 'proj-2')).toBe(false);
  });

  it('offers them everywhere to a platform admin', () => {
    const admin = aPrincipal({ globalRoles: ['platform_admin'] });
    expect(canAdministerProject(admin, 'any-project')).toBe(true);
    expect(canCreateProject(admin)).toBe(true);
  });

  it('does not let a project owner create projects', () => {
    const owner = aPrincipal({ memberships: [{ projectId: 'p', roles: ['project_owner'] }] });
    expect(canCreateProject(owner)).toBe(false);
  });

  it('falls back through display name, email and id', () => {
    expect(displayNameOf(aPrincipal({ displayName: 'Ana', email: 'a@b.c' }))).toBe('Ana');
    expect(displayNameOf(aPrincipal({ email: 'a@b.c' }))).toBe('a@b.c');
    expect(displayNameOf(aPrincipal())).toBe('user-1');
  });
});

import { describe, expect, it } from 'vitest';

import {
  activeItemId,
  projectIdFromLocation,
  projectNav,
} from '../src/modules/console/domain/navigation';
import type { Principal } from '../src/modules/console/domain/session';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'user-1',
    type: 'user',
    globalRoles: [],
    memberships: [],
    ...overrides,
  };
}

const OWNER = principal({ memberships: [{ projectId: 'p1', roles: ['project_owner'] }] });
const VIEWER = principal({ memberships: [{ projectId: 'p1', roles: ['project_viewer'] }] });

describe('projectNav', () => {
  it('offers Settings to someone who can administer the project', () => {
    const ids = projectNav(OWNER, 'p1').flatMap((s) => s.items.map((i) => i.id));
    expect(ids).toContain('settings');
  });

  // Hiding it is a courtesy, not a control -- governance still authorises the
  // write. The test exists so the courtesy does not silently disappear.
  it('hides Settings from a viewer', () => {
    const ids = projectNav(VIEWER, 'p1').flatMap((s) => s.items.map((i) => i.id));
    expect(ids).not.toContain('settings');
    expect(ids).toContain('overview');
  });

  it('drops a group that has no items rather than rendering an empty heading', () => {
    const groups = projectNav(VIEWER, 'p1').map((s) => s.group);
    expect(groups).not.toContain('manage');
    expect(groups).toContain('build');
  });

  // A project id reaches this from the URL. It must not be able to break out.
  it('encodes the project id into every href', () => {
    const items = projectNav(OWNER, 'a/b?c').flatMap((s) => s.items);
    for (const item of items) {
      expect(item.href).not.toContain('a/b?c');
      expect(item.href).toContain('a%2Fb%3Fc');
    }
  });
});

describe('activeItemId', () => {
  const sections = projectNav(OWNER, 'p1');

  it('marks the exact match', () => {
    expect(activeItemId(sections, '/projects/p1')).toBe('overview');
  });

  // The bug this guards: Overview is a prefix of Settings, so a naive
  // startsWith would light up both.
  it('prefers the longest match over a prefix', () => {
    expect(activeItemId(sections, '/projects/p1/settings')).toBe('settings');
  });

  it('ignores the query string when matching', () => {
    expect(activeItemId(sections, '/chat')).toBe('playground');
  });

  it('returns undefined when nothing matches', () => {
    expect(activeItemId(sections, '/login')).toBeUndefined();
  });
});

describe('projectIdFromLocation', () => {
  it('reads the id from a project route', () => {
    expect(projectIdFromLocation('/projects/p1')).toBe('p1');
    expect(projectIdFromLocation('/projects/p1/settings')).toBe('p1');
  });

  it('reads the id from the playground query', () => {
    expect(projectIdFromLocation('/chat', '?project=p1')).toBe('p1');
  });

  it('decodes an escaped id', () => {
    expect(projectIdFromLocation('/projects/a%2Fb')).toBe('a/b');
  });

  // A hand-edited URL must not throw inside a layout and blank the whole page.
  it('survives a malformed escape', () => {
    expect(projectIdFromLocation('/projects/%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('has no project outside a project context', () => {
    expect(projectIdFromLocation('/')).toBeUndefined();
    expect(projectIdFromLocation('/login')).toBeUndefined();
    expect(projectIdFromLocation('/chat')).toBeUndefined();
    expect(projectIdFromLocation('/chat', '?project=')).toBeUndefined();
  });
});

/**
 * What the console's left rail contains.
 *
 * Navigation is data, not JSX: the shell renders whatever this returns, so
 * adding a section is one entry here rather than an edit inside a layout. The
 * grouping follows the platform's own shape -- what you build, what you watch,
 * what you administer.
 *
 * Only implemented sections appear. A rail advertising a page that answers 404
 * is worse than a short rail.
 */
import { canAdministerProject, type Principal } from './session';

export const NAV_GROUPS = ['build', 'observe', 'manage'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly group: NavGroup;
  /** Named here, resolved to a component by the shell: this module stays pure. */
  readonly icon: string;
}

export interface NavSection {
  readonly group: NavGroup;
  readonly label: string;
  readonly items: readonly NavItem[];
}

const GROUP_LABELS: Record<NavGroup, string> = {
  build: 'Build',
  observe: 'Observe',
  manage: 'Manage',
};

/**
 * The rail for a project.
 *
 * `canAdministerProject` decides whether Settings is offered. As everywhere in
 * this console, that only hides a control -- governance authorises the write.
 */
export function projectNav(principal: Principal, projectId: string): NavSection[] {
  const base = `/projects/${encodeURIComponent(projectId)}`;

  const items: NavItem[] = [
    { id: 'overview', label: 'Overview', href: base, group: 'build', icon: 'home' },
    { id: 'agents', label: 'Agents', href: `${base}/agents`, group: 'build', icon: 'bot' },
    {
      id: 'vector-stores',
      label: 'Vector stores',
      href: `${base}/vector-stores`,
      group: 'build',
      icon: 'library',
    },
    { id: 'tools', label: 'Tools', href: `${base}/tools`, group: 'build', icon: 'toolbox' },
    {
      id: 'connections',
      label: 'Connections',
      href: `${base}/connections`,
      group: 'build',
      icon: 'plug',
    },
    {
      id: 'playground',
      label: 'Playground',
      href: `/chat?project=${encodeURIComponent(projectId)}`,
      group: 'build',
      icon: 'chat',
    },
  ];

  items.push({
    id: 'evaluations',
    label: 'Evaluations',
    href: `${base}/evaluations`,
    group: 'observe',
    icon: 'beaker',
  });

  items.push({
    id: 'traces',
    label: 'Traces',
    href: `${base}/traces`,
    group: 'observe',
    icon: 'pulse',
  });

  if (canAdministerProject(principal, projectId)) {
    items.push({
      id: 'settings',
      label: 'Settings',
      href: `${base}/settings`,
      group: 'manage',
      icon: 'settings',
    });
  }

  return groupItems(items);
}

function groupItems(items: readonly NavItem[]): NavSection[] {
  return NAV_GROUPS.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: items.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0);
}

/**
 * Whether a rail entry should read as current.
 *
 * Longest-match, not equality: `/projects/x` must not light up while the user
 * is on `/projects/x/settings`, or two entries look current at once.
 */
export function activeItemId(
  sections: readonly NavSection[],
  pathname: string,
): string | undefined {
  const candidates = sections
    .flatMap((section) => section.items)
    .map((item) => ({ item, path: item.href.split('?')[0] ?? item.href }))
    .filter(({ path }) => pathname === path || pathname.startsWith(`${path}/`))
    .sort((a, b) => b.path.length - a.path.length);

  return candidates[0]?.item.id;
}

/**
 * The project the rail should describe, read from the location.
 *
 * Two shapes carry a project today: the `/projects/:id` segment, and the
 * playground's `?project=` query. Deriving it here keeps the shell from
 * pattern-matching URLs inline, and makes both shapes testable without a
 * router.
 */
export function projectIdFromLocation(pathname: string, search?: string): string | undefined {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments[0] === 'projects' && segments[1] !== undefined) {
    return safeDecode(segments[1]);
  }

  if (segments[0] === 'chat' && search !== undefined && search.length > 0) {
    const fromQuery = new URLSearchParams(search).get('project');
    if (fromQuery !== null && fromQuery.length > 0) return fromQuery;
  }

  return undefined;
}

/** A malformed escape in the URL is not a reason to blank the whole rail. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

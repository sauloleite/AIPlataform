'use client';

import { Divider, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Bot24Regular,
  Chat24Regular,
  Grid24Regular,
  Home24Regular,
  Library24Regular,
  Settings24Regular,
  Beaker24Regular,
  PlugConnected24Regular,
  Pulse24Regular,
  Toolbox24Regular,
} from '@fluentui/react-icons';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';

import {
  activeItemId,
  projectIdFromLocation,
  projectNav,
  type NavItem,
} from '../../modules/console/domain/navigation';
import { displayNameOf, type Principal } from '../../modules/console/domain/session';

const RAIL_WIDTH = '248px';

const useStyles = makeStyles({
  shell: { display: 'flex', flexDirection: 'column', minHeight: '100vh' },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingInline: tokens.spacingHorizontalL,
    height: '48px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  brand: { textDecoration: 'none', color: tokens.colorNeutralForeground1, fontWeight: 600 },
  brandAccent: { color: tokens.colorBrandForeground1 },
  spacer: { flex: 1 },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  rail: {
    width: RAIL_WIDTH,
    flexShrink: 0,
    paddingBlock: tokens.spacingVerticalM,
    paddingInline: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  groupLabel: {
    display: 'block',
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  link: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalSNudge,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  linkActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    fontWeight: tokens.fontWeightSemibold,
  },
  // The current entry is marked with a bar as well as a tint: colour alone is
  // not a distinction everyone can see.
  activeBar: {
    width: '3px',
    alignSelf: 'stretch',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorBrandForeground1,
  },
  inactiveBar: { width: '3px', alignSelf: 'stretch' },
  content: { flex: 1, minWidth: 0, paddingInline: tokens.spacingHorizontalXXL },
});

const ICONS: Record<string, ReactElement> = {
  home: <Home24Regular />,
  bot: <Bot24Regular />,
  library: <Library24Regular />,
  toolbox: <Toolbox24Regular />,
  plug: <PlugConnected24Regular />,
  pulse: <Pulse24Regular />,
  beaker: <Beaker24Regular />,
  chat: <Chat24Regular />,
  settings: <Settings24Regular />,
};

export function AppShell({
  principal,
  signOut,
  children,
}: {
  principal: Principal | null;
  signOut: ReactNode;
  children: ReactNode;
}): ReactElement {
  const styles = useStyles();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const projectId =
    principal === null ? undefined : projectIdFromLocation(pathname, searchParams.toString());
  const sections =
    principal !== null && projectId !== undefined ? projectNav(principal, projectId) : [];
  const activeId = activeItemId(sections, pathname);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/">
          AIA <span className={styles.brandAccent}>Console</span>
        </a>
        {principal !== null && (
          <>
            <Divider vertical style={{ height: '20px', flexGrow: 0 }} />
            <a className={styles.brand} href="/" style={{ fontWeight: 400 }}>
              Projects
            </a>
            <div className={styles.spacer} />
            <Text size={200}>{displayNameOf(principal)}</Text>
            {signOut}
          </>
        )}
      </header>
      <div className={styles.body}>
        {sections.length > 0 && (
          <nav className={styles.rail} aria-label="Project">
            {sections.map((section) => (
              <div key={section.group}>
                <Text as="span" size={100} weight="semibold" className={styles.groupLabel}>
                  {section.label}
                </Text>
                {section.items.map((item) => (
                  <RailLink
                    key={item.id}
                    item={item}
                    active={item.id === activeId}
                    styles={styles}
                  />
                ))}
              </div>
            ))}
          </nav>
        )}
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}

function RailLink({
  item,
  active,
  styles,
}: {
  item: NavItem;
  active: boolean;
  styles: ReturnType<typeof useStyles>;
}): ReactElement {
  return (
    <a
      href={item.href}
      className={mergeClasses(styles.link, active && styles.linkActive)}
      aria-current={active ? 'page' : undefined}
    >
      <span className={active ? styles.activeBar : styles.inactiveBar} aria-hidden="true" />
      {ICONS[item.icon] ?? <Grid24Regular />}
      {item.label}
    </a>
  );
}

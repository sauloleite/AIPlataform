import { createCSSRuleFromTheme } from '@fluentui/react-provider';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import './globals.css';
import { getContainer } from '../container';
import { resolveTheme, THEME_COOKIE } from '../modules/console/domain/theme';
import { AppShell } from './_ui/app-shell';
import { aiaDarkTheme, aiaLightTheme } from './_ui/brand';
import { ConsoleProviders } from './_ui/console-providers';
import { SignOutButton } from './sign-out-button';

export const metadata: Metadata = {
  title: 'AIA Console',
  description: 'Projects, budget, policies and a chat playground for the AIA platform',
};

// The console reads live platform state on every request. Caching a page would
// show a budget that has already been spent.
export const dynamic = 'force-dynamic';

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const { sessions } = await getContainer();
  const [session, jar, headerList] = await Promise.all([sessions.read(), cookies(), headers()]);

  const theme = resolveTheme({
    cookie: jar.get(THEME_COOKIE)?.value,
    clientHint: headerList.get('sec-ch-prefers-color-scheme') ?? undefined,
  });

  // FluentProvider scopes its variables to a generated class on a div inside
  // <body>, so anything outside that div -- the body background above all --
  // would resolve to nothing until hydration. Emitting the same variables at
  // :root from the server makes the very first byte correct instead.
  const themeRule = createCSSRuleFromTheme(
    ':root',
    theme === 'dark' ? aiaDarkTheme : aiaLightTheme,
  );

  return (
    <html lang="en" data-theme={theme} style={{ colorScheme: theme }}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeRule }} />
      </head>
      <body>
        <ConsoleProviders theme={theme}>
          <AppShell principal={session?.principal ?? null} signOut={<SignOutButton />}>
            {children}
          </AppShell>
        </ConsoleProviders>
      </body>
    </html>
  );
}

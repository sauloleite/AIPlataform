import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { getContainer } from '../container';
import { displayNameOf } from '../modules/console/domain/session';
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
  const session = await sessions.read();

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <a className="brand" href="/">
              AIA <span>Console</span>
            </a>
            {session !== null && (
              <>
                <nav>
                  <a href="/">Projects</a>
                  <a href="/chat">Playground</a>
                </nav>
                <div className="spacer" />
                <span className="who">{displayNameOf(session.principal)}</span>
                <SignOutButton />
              </>
            )}
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}

'use client';

import { FluentProvider, SSRProvider } from '@fluentui/react-components';
import type { ReactElement, ReactNode } from 'react';

import type { ThemeName } from '../../modules/console/domain/theme';
import { aiaDarkTheme, aiaLightTheme } from './brand';
import { GriffelRegistry } from './griffel-registry';

/**
 * The client context Fluent needs, wrapped once around the whole console.
 *
 * The theme arrives as a prop resolved on the server, never from `matchMedia`:
 * reading the media query here would mean rendering the wrong theme first and
 * correcting it after hydration.
 */
export function ConsoleProviders({
  theme,
  children,
}: {
  theme: ThemeName;
  children: ReactNode;
}): ReactElement {
  return (
    <GriffelRegistry>
      {/* Fluent's `useId` counts through this context, not React's. Without it
          the ids differ between server and client and hydration breaks. */}
      <SSRProvider>
        <FluentProvider theme={theme === 'dark' ? aiaDarkTheme : aiaLightTheme}>
          {children}
        </FluentProvider>
      </SSRProvider>
    </GriffelRegistry>
  );
}

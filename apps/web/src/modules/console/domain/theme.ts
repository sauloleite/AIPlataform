/**
 * Which theme to render, decided on the server.
 *
 * Fluent's theme is a JavaScript object resolved at render time, not a CSS
 * media query, so `prefers-color-scheme` cannot decide it: the server never
 * sees the query, and correcting after hydration is a visible flash. The
 * preference therefore lives in a cookie the server can read, exactly like the
 * session does.
 *
 * The cookie is deliberately NOT httpOnly and deliberately not named like the
 * session cookies: it is a display preference, not a credential, and nothing
 * here may ever be mistaken for one.
 */

export const THEMES = ['light', 'dark'] as const;
export type ThemeName = (typeof THEMES)[number];

export const PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof PREFERENCES)[number];

export const THEME_COOKIE = 'aia_theme';

/** The theme used when nothing else says otherwise. */
export const DEFAULT_THEME: ThemeName = 'light';

export function parsePreference(raw: string | undefined): ThemePreference {
  return PREFERENCES.includes(raw as ThemePreference) ? (raw as ThemePreference) : 'system';
}

/**
 * Resolves the theme to render.
 *
 * An explicit choice wins. Failing that, Chromium sends the user's OS setting
 * in `Sec-CH-Prefers-Color-Scheme` once the response asks for it, which covers
 * the first visit with no flash. Firefox and Safari send nothing, so they get
 * the default until the user touches the toggle -- a worse first paint than a
 * flash would be, and the only honest alternative without an inline script.
 */
export function resolveTheme(input: { cookie?: string; clientHint?: string }): ThemeName {
  const preference = parsePreference(input.cookie);
  if (preference !== 'system') return preference;

  const hint = input.clientHint?.trim().toLowerCase();
  return THEMES.includes(hint as ThemeName) ? (hint as ThemeName) : DEFAULT_THEME;
}

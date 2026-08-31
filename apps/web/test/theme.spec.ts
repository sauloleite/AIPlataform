import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME, parsePreference, resolveTheme } from '../src/modules/console/domain/theme';

describe('parsePreference', () => {
  it('accepts the three known preferences', () => {
    expect(parsePreference('light')).toBe('light');
    expect(parsePreference('dark')).toBe('dark');
    expect(parsePreference('system')).toBe('system');
  });

  // A cookie is user-controlled input. Anything unrecognised falls back to
  // 'system' rather than reaching FluentProvider as an invalid theme name.
  it('falls back to system for an absent or unknown value', () => {
    expect(parsePreference(undefined)).toBe('system');
    expect(parsePreference('')).toBe('system');
    expect(parsePreference('solarized')).toBe('system');
    expect(parsePreference('__proto__')).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('honours an explicit choice over the client hint', () => {
    expect(resolveTheme({ cookie: 'light', clientHint: 'dark' })).toBe('light');
    expect(resolveTheme({ cookie: 'dark', clientHint: 'light' })).toBe('dark');
  });

  it('uses the client hint when the preference is system', () => {
    expect(resolveTheme({ cookie: 'system', clientHint: 'dark' })).toBe('dark');
    expect(resolveTheme({ cookie: 'system', clientHint: 'light' })).toBe('light');
  });

  it('uses the client hint when there is no cookie at all', () => {
    expect(resolveTheme({ clientHint: 'dark' })).toBe('dark');
  });

  it('tolerates the casing and padding a header can arrive with', () => {
    expect(resolveTheme({ clientHint: ' Dark ' })).toBe('dark');
  });

  // Firefox and Safari send no hint. That has to be a default, not a crash.
  it('falls back to the default when nothing is known', () => {
    expect(resolveTheme({})).toBe(DEFAULT_THEME);
    expect(resolveTheme({ cookie: 'system' })).toBe(DEFAULT_THEME);
    expect(resolveTheme({ cookie: 'system', clientHint: 'sepia' })).toBe(DEFAULT_THEME);
  });
});

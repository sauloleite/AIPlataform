/**
 * The AIA brand ramp, and the two themes built from it.
 *
 * Pure module: no `'use client'`, no component. The root layout is a Server
 * Component and needs these values to emit the theme variables at `:root`
 * before any markup streams, so nothing here may drag in React.
 *
 * The ramp is seeded from the console's original accent (#b04a2f), held at
 * slot 80 -- the slot `createLightTheme` uses for `colorBrandBackground`, so
 * the primary button keeps exactly the colour the hand-written CSS had.
 * Hue and saturation are constant; only lightness moves, with saturation
 * easing off at the light end so the pale steps do not read as pink.
 */
import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from '@fluentui/react-theme';

export const aiaBrand: BrandVariants = {
  10: '#1e0d08',
  20: '#2e130c',
  30: '#3e1a11',
  40: '#512215',
  50: '#63291a',
  60: '#773220',
  70: '#913d27',
  80: '#b04a2f',
  90: '#c55335',
  100: '#ce6448',
  110: '#d4775e',
  120: '#d68c78',
  130: '#daa192',
  140: '#e1b8ad',
  150: '#e9cfc9',
  160: '#f3e8e5',
};

export const aiaLightTheme: Theme = createLightTheme(aiaBrand);
export const aiaDarkTheme: Theme = createDarkTheme(aiaBrand);

/**
 * Console domain.
 *
 * Pure rules: no React, no fetch, no cookies. Everything here is testable
 * without rendering anything, which is what keeps the console's own logic from
 * hiding inside a component.
 */
export * from './money';
export * from './classification';
export * from './session';
export * from './errors';

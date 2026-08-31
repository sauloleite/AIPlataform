/**
 * How a budget reads on screen.
 *
 * The thresholds are the platform's, not the console's: 80% is the first alert
 * the governance service raises, and 100% is where the router starts refusing
 * calls with `budget_exhausted`. They live here once because the projects list
 * and the project page were drifting apart with a copy each.
 */

export type BudgetTone = 'ok' | 'warn' | 'danger';

export const ALERT_RATIO = 0.8;
export const BLOCK_RATIO = 1;

export function toneFor(ratio: number): BudgetTone {
  if (!Number.isFinite(ratio)) return 'ok';
  if (ratio >= BLOCK_RATIO) return 'danger';
  if (ratio >= ALERT_RATIO) return 'warn';
  return 'ok';
}

/** The percentage to show. Clamped: a bar wider than its track is a layout bug. */
export function percentFor(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0) return 0;
  return Math.min(100, Math.round(ratio * 100));
}

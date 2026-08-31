import { describe, expect, it } from 'vitest';

import { percentFor, toneFor } from '../src/modules/console/domain/budget-meter';

describe('toneFor', () => {
  it('is calm below the alert threshold', () => {
    expect(toneFor(0)).toBe('ok');
    expect(toneFor(0.79)).toBe('ok');
  });

  // The boundaries are the platform's own: 80% alerts, 100% refuses calls.
  it('warns from the alert threshold and blocks from the limit', () => {
    expect(toneFor(0.8)).toBe('warn');
    expect(toneFor(0.99)).toBe('warn');
    expect(toneFor(1)).toBe('danger');
    expect(toneFor(1.5)).toBe('danger');
  });

  // A budget of zero divides by zero upstream. That must not paint the meter red
  // for a project that has simply not spent anything.
  it('treats a non-finite ratio as calm', () => {
    expect(toneFor(Number.NaN)).toBe('ok');
    expect(toneFor(Number.POSITIVE_INFINITY)).toBe('ok');
  });
});

describe('percentFor', () => {
  it('rounds to whole percent', () => {
    expect(percentFor(0.333)).toBe(33);
    expect(percentFor(0.5)).toBe(50);
  });

  // Overspend is real (a reservation can commit above the limit). The number may
  // exceed 100, the BAR may not.
  it('clamps above the limit and below zero', () => {
    expect(percentFor(1.4)).toBe(100);
    expect(percentFor(-1)).toBe(0);
    expect(percentFor(Number.NaN)).toBe(0);
  });
});

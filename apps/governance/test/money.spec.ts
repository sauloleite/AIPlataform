import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { Money } from '../src/modules/projects/domain/value-objects/money.js';

describe('Money', () => {
  it('sums thousands of fractional costs without accumulating error', () => {
    // 10,000 calls at 0.000123 each. In floating point this drifts.
    let total = Money.zero('BRL');
    const unit = Money.of(123n, 'BRL');
    for (let i = 0; i < 10_000; i += 1) total = total.plus(unit);

    expect(total.micros).toBe(1_230_000n);
    expect(total.toUnits()).toBe(1.23);
  });

  it('converts units into micros', () => {
    expect(Money.fromUnits(1.5, 'BRL').micros).toBe(1_500_000n);
  });

  it('minus never goes negative: remaining budget floors at zero, never owing', () => {
    expect(Money.of(100n, 'BRL').minus(Money.of(500n, 'BRL')).micros).toBe(0n);
  });

  it('rejects operating across different currencies', () => {
    expect(() => Money.of(100n, 'BRL').plus(Money.of(100n, 'USD'))).toThrow(ValidationError);
  });

  it('rejects a negative amount and an invalid currency', () => {
    expect(() => Money.of(-1n, 'BRL')).toThrow(ValidationError);
    expect(() => Money.of(1n, 'brl')).toThrow(ValidationError);
    expect(() => Money.of(1n, 'REAL')).toThrow(ValidationError);
  });

  it('ratioOf treats a zero limit as fully consumed', () => {
    expect(Money.of(1n, 'BRL').ratioOf(Money.zero('BRL'))).toBe(1);
    expect(Money.zero('BRL').ratioOf(Money.zero('BRL'))).toBe(0);
  });
});

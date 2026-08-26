import { describe, expect, it } from 'vitest';
import { Money } from '../src/modules/console/domain/money';

describe('Money', () => {
  it('keeps precision a float would lose', () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004. On integers it is not.
    const tenth = Money.of('BRL', 100_000n);
    const fifth = Money.of('BRL', 200_000n);

    expect(tenth.plus(fifth).micros).toBe(300_000n);
    expect(tenth.plus(fifth).format()).toBe('BRL 0.30');
  });

  it('reads micros arriving as a string, which is how large budgets travel', () => {
    // Above 2^53 a JSON number would already have rounded.
    const huge = Money.fromJson({ currency: 'BRL', micros: '9007199254740993' });
    expect(huge.micros).toBe(9_007_199_254_740_993n);
  });

  it('shows more decimals for a cost below one cent', () => {
    // A cheap call has to look different from a free one, or the playground
    // would report every local answer and every 0.000004 answer as "0.00".
    expect(Money.of('BRL', 4n).format()).toBe('BRL 0.000004');
    expect(Money.of('BRL', 0n).format()).toBe('BRL 0.00');
  });

  it('formats a negative amount without losing the sign', () => {
    expect(Money.of('BRL', -1_500_000n).format()).toBe('-BRL 1.50');
  });

  it('reports a project with no limit as 0% used, never as full', () => {
    const spent = Money.of('BRL', 5_000_000n);
    expect(spent.ratioOf(Money.zero('BRL'))).toBe(0);
  });

  it('computes the ratio against a real limit', () => {
    const spent = Money.of('BRL', 40_000_000n);
    const limit = Money.of('BRL', 50_000_000n);
    expect(spent.ratioOf(limit)).toBeCloseTo(0.8);
  });

  it('refuses to combine different currencies', () => {
    expect(() => Money.of('BRL', 1n).plus(Money.of('USD', 1n))).toThrow(/BRL with USD/);
  });

  it('refuses a currency that is not a 3-letter code', () => {
    expect(() => Money.of('REAL', 1n)).toThrow(/3-letter/);
  });
});

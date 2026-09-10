import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { BudgetReservation } from '../src/modules/completions/domain/entities/budget-reservation.js';
import { Cost } from '../src/modules/completions/domain/value-objects/index.js';
import { RedisBudgetLedger } from '../src/modules/completions/infrastructure/redis/redis-budget-ledger.js';

/**
 * The ledger against a Redis that only records what it was asked to run.
 *
 * Every other test in this suite uses `FakeBudgetLedger`, which is the right
 * fake for a use case and says nothing about the script this class actually
 * sends. The guards below are on THIS side of the port, and getting one wrong
 * moves money.
 */
function aLedger(): { ledger: RedisBudgetLedger; scripts: string[] } {
  const scripts: string[] = [];
  const redis = {
    on: vi.fn(),
    eval: vi.fn((script: string) => {
      scripts.push(script);
      return Promise.resolve([1, '0']);
    }),
  } as unknown as Redis;

  return { ledger: new RedisBudgetLedger(redis), scripts };
}

function aHeldReservation(): BudgetReservation {
  return BudgetReservation.held({
    id: 'res-1',
    projectId: 'proj-1',
    estimated: Cost.of(1_000n, 'BRL'),
    periodKey: '2026-09',
  });
}

describe('releasing a budget reservation', () => {
  it('gives the estimate back once', async () => {
    const { ledger, scripts } = aLedger();

    await ledger.release(aHeldReservation());

    expect(scripts).toHaveLength(1);
  });

  it('releasing twice refunds once', async () => {
    // The compensation runs in a `finally` and may coincide with a late error,
    // so the entity has always documented a second release as harmless. The
    // ledger did not honour it: the script ran again and the project's
    // remaining budget grew by an estimate nobody had spent.
    const { ledger, scripts } = aLedger();
    const reservation = aHeldReservation();

    await ledger.release(reservation);
    await ledger.release(reservation);

    expect(scripts).toHaveLength(1);
  });

  it('a committed reservation is not released', async () => {
    const { ledger, scripts } = aLedger();
    const reservation = aHeldReservation();

    await ledger.commit(reservation, Cost.of(400n, 'BRL'));
    scripts.length = 0;
    await ledger.release(reservation);

    expect(scripts).toHaveLength(0);
  });

  it('an unverified reservation has nothing to give back', async () => {
    // Redis was unreachable when it was taken, so nothing was ever counted.
    const { ledger, scripts } = aLedger();

    await ledger.release(BudgetReservation.unverified('proj-1', 'BRL'));

    expect(scripts).toHaveLength(0);
  });
});

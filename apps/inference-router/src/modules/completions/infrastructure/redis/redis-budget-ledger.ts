import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { BudgetReservation } from '../../domain/entities/budget-reservation.js';
import { BudgetExhaustedError } from '../../domain/errors/index.js';
import { Cost } from '../../domain/value-objects/index.js';
import type { BudgetLedger, ReserveInput } from '../../application/ports.js';

/**
 * Budget accounting in Redis, with atomicity guaranteed by Lua.
 *
 * Why Lua and not GET + SET: between reading the balance and writing it, another
 * replica can read the SAME balance. With N concurrent calls, every one of them
 * would slip past the limit. The script runs entirely inside Redis, with no
 * interleaving possible.
 *
 * The state is two counters per project and period:
 *   spent    - already confirmed
 *   reserved - held by calls in flight
 * Authorisation looks at the SUM of both; the commit moves `reserved` to `spent`.
 */
@Injectable()
export class RedisBudgetLedger implements BudgetLedger {
  private readonly logger = new Logger(RedisBudgetLedger.name);
  private healthy = true;

  /**
   * Reserve: fails if `spent + reserved + estimate` exceeds the limit.
   * Returns `{ok, reservedTotal}` so the caller knows the resulting state.
   */
  private static readonly RESERVE = `
    local spentKey, reservedKey = KEYS[1], KEYS[2]
    local estimated  = tonumber(ARGV[1])
    local limit      = tonumber(ARGV[2])
    local ttl        = tonumber(ARGV[3])
    local blocking   = ARGV[4] == '1'

    local spent    = tonumber(redis.call('GET', spentKey) or '0')
    local reserved = tonumber(redis.call('GET', reservedKey) or '0')

    if blocking and (spent + reserved + estimated) > limit then
      return { 0, spent + reserved }
    end

    redis.call('INCRBY', reservedKey, estimated)
    -- The TTL tracks the period end: the roll-over clears the counters itself.
    redis.call('EXPIRE', reservedKey, ttl)
    redis.call('EXPIRE', spentKey, ttl)
    return { 1, spent + reserved + estimated }
  `;

  /**
   * Commit: releases the reservation and adds the real cost to spend.
   * The `max(0, ...)` guards against a reservation already expired by TTL.
   */
  private static readonly COMMIT = `
    local spentKey, reservedKey = KEYS[1], KEYS[2]
    local estimated = tonumber(ARGV[1])
    local actual    = tonumber(ARGV[2])
    local ttl       = tonumber(ARGV[3])

    local reserved = tonumber(redis.call('GET', reservedKey) or '0')
    local newReserved = reserved - estimated
    if newReserved < 0 then newReserved = 0 end

    redis.call('SET', reservedKey, newReserved, 'EX', ttl)
    local spent = redis.call('INCRBY', spentKey, actual)
    redis.call('EXPIRE', spentKey, ttl)
    return { spent, newReserved }
  `;

  /** Release: returns the estimate without touching spend. The saga compensation. */
  private static readonly RELEASE = `
    local reservedKey = KEYS[1]
    local estimated = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])

    local reserved = tonumber(redis.call('GET', reservedKey) or '0')
    local newReserved = reserved - estimated
    if newReserved < 0 then newReserved = 0 end

    redis.call('SET', reservedKey, newReserved, 'EX', ttl)
    return newReserved
  `;

  /**
   * TTL used on commit and release. The exact value matters little: the key
   * already carries the period, so expiring early only costs a re-read.
   */
  private readonly ttlSeconds = 40 * 24 * 60 * 60;

  constructor(private readonly redis: Redis) {
    redis.on('error', (error: Error) => {
      if (this.healthy) {
        this.logger.warn(`Redis unreachable: ${error.message}. Entering budget_unverified.`);
      }
      this.healthy = false;
    });
    redis.on('ready', () => {
      if (!this.healthy) this.logger.log('Redis is back. Budget is verified again.');
      this.healthy = true;
    });
  }

  isAvailable(): boolean {
    return this.healthy && this.redis.status === 'ready';
  }

  /**
   * The counter keys.
   *
   * The period key comes from outside and is STABLE (`2026-03`): deriving it from
   * the current time would land the reserve and the commit of the same call on
   * different keys, and the budget would never accumulate. A period roll-over
   * changes the key by itself, with no migration and no cleanup job.
   */
  private keysFor(projectId: string, periodKey: string): [string, string] {
    const prefix = `aia:budget:${projectId}:${periodKey}`;
    return [`${prefix}:spent`, `${prefix}:reserved`];
  }

  async reserve(input: ReserveInput): Promise<BudgetReservation> {
    const keys = this.keysFor(input.projectId, input.periodKey);
    const ttl = Math.max(60, input.periodEndsInSeconds);

    const [ok] = (await this.redis.eval(
      RedisBudgetLedger.RESERVE,
      2,
      keys[0],
      keys[1],
      input.estimated.micros.toString(),
      input.limitMicros.toString(),
      ttl.toString(),
      input.blockAtLimit ? '1' : '0',
    )) as [number, number];

    if (ok !== 1) {
      throw new BudgetExhaustedError(input.projectId, Math.max(1, input.periodEndsInSeconds));
    }

    return BudgetReservation.held({
      id: randomUUID(),
      projectId: input.projectId,
      estimated: input.estimated,
      periodKey: input.periodKey,
    });
  }

  async commit(reservation: BudgetReservation, actual: Cost): Promise<void> {
    if (reservation.isUnverified) {
      reservation.commit(actual);
      return;
    }

    // The reservation itself says where and how much: nothing depends on this
    // process's state, so a restart between reserve and commit loses no accounting.
    const keys = this.keysFor(reservation.projectId, reservation.periodKey);

    await this.redis.eval(
      RedisBudgetLedger.COMMIT,
      2,
      keys[0],
      keys[1],
      reservation.estimated.micros.toString(),
      actual.micros.toString(),
      this.ttlSeconds.toString(),
    );

    reservation.commit(actual);
  }

  async release(reservation: BudgetReservation): Promise<void> {
    if (reservation.isUnverified || reservation.state === 'committed') return;

    const keys = this.keysFor(reservation.projectId, reservation.periodKey);

    await this.redis.eval(
      RedisBudgetLedger.RELEASE,
      1,
      keys[1],
      reservation.estimated.micros.toString(),
      this.ttlSeconds.toString(),
    );

    reservation.release();
  }

  /** Current state, for the daily reconciliation and the FinOps dashboard. */
  async snapshot(
    projectId: string,
    periodKey: string,
  ): Promise<{ spentMicros: bigint; reservedMicros: bigint }> {
    const keys = this.keysFor(projectId, periodKey);
    const [spent, reserved] = await this.redis.mget(keys[0], keys[1]);
    return {
      spentMicros: BigInt(spent ?? '0'),
      reservedMicros: BigInt(reserved ?? '0'),
    };
  }
}

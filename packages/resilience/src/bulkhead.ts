import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';
import type { BulkheadPolicy } from './types.js';

export class ConcurrencyLimitError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.CONCURRENCY_LIMIT;
  readonly status = 429;
  override readonly retryable = true;

  constructor(key: string, maxConcurrent: number) {
    super(`Reached the limit of ${maxConcurrent} concurrent calls`, {
      key,
      max_concurrent: maxConcurrent,
      retry_after: 1,
    });
  }
}

/** A slot acquired from the semaphore. Always release it in a `finally`. */
export interface BulkheadLease {
  release(): Promise<void>;
}

/**
 * Caps concurrency per key so that one project cannot consume the capacity of
 * every other one (reference doc 02 §9).
 */
export interface Bulkhead {
  acquire(key: string): Promise<BulkheadLease>;
}

/** Per-process semaphore. Enough for a single replica, or for tests. */
export class InMemoryBulkhead implements Bulkhead {
  private readonly inFlight = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  constructor(private readonly policy: BulkheadPolicy) {}

  async acquire(key: string): Promise<BulkheadLease> {
    const current = this.inFlight.get(key) ?? 0;

    if (current < this.policy.maxConcurrent) {
      this.inFlight.set(key, current + 1);
      return this.leaseFor(key);
    }

    await this.waitForSlot(key);
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    return this.leaseFor(key);
  }

  private waitForSlot(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = this.waiting.get(key) ?? [];
      const timer = setTimeout(() => {
        const index = queue.indexOf(onSlot);
        if (index >= 0) queue.splice(index, 1);
        reject(new ConcurrencyLimitError(key, this.policy.maxConcurrent));
      }, this.policy.acquireTimeoutMs);

      const onSlot = (): void => {
        clearTimeout(timer);
        resolve();
      };

      queue.push(onSlot);
      this.waiting.set(key, queue);
    });
  }

  private leaseFor(key: string): BulkheadLease {
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        this.inFlight.set(key, Math.max(0, (this.inFlight.get(key) ?? 1) - 1));
        this.waiting.get(key)?.shift()?.();
        return Promise.resolve();
      },
    };
  }
}

/** The minimal Redis surface the bulkhead needs. Avoids coupling to ioredis. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Distributed semaphore in Redis: the limit applies across every replica.
 *
 * Each slot is a sorted-set member scored with its expiry, so a process that
 * dies without releasing does not wedge the semaphore forever.
 */
export class RedisBulkhead implements Bulkhead {
  private static readonly ACQUIRE = `
    local key, now, ttl, limit, member = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]),
                                         tonumber(ARGV[3]), ARGV[4]
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
    if redis.call('ZCARD', key) >= limit then return 0 end
    redis.call('ZADD', key, now + ttl, member)
    redis.call('PEXPIRE', key, ttl)
    return 1
  `;

  private static readonly RELEASE = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

  constructor(
    private readonly redis: RedisLike,
    private readonly policy: BulkheadPolicy,
    private readonly keyPrefix = 'aia:bulkhead',
  ) {}

  async acquire(key: string): Promise<BulkheadLease> {
    const redisKey = `${this.keyPrefix}:${key}`;
    const ttl = this.policy.leaseTtlMs ?? 60_000;
    const deadline = Date.now() + this.policy.acquireTimeoutMs;

    for (;;) {
      const member = `${process.pid.toString()}-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
      const acquired = await this.redis.eval(
        RedisBulkhead.ACQUIRE,
        1,
        redisKey,
        Date.now(),
        ttl,
        this.policy.maxConcurrent,
        member,
      );

      if (acquired === 1) {
        let released = false;
        return {
          release: async (): Promise<void> => {
            if (released) return;
            released = true;
            await this.redis.eval(RedisBulkhead.RELEASE, 1, redisKey, member);
          },
        };
      }

      if (Date.now() >= deadline) {
        throw new ConcurrencyLimitError(key, this.policy.maxConcurrent);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

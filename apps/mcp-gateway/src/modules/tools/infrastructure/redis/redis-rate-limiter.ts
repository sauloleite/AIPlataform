import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import type { RateLimiter } from '../../application/ports.js';

const WINDOW_SECONDS = 60;

/**
 * A fixed-window counter per project and tool.
 *
 * INCR then EXPIRE in one round trip, so two concurrent callers cannot both
 * see a fresh counter and both set the window. A fixed window admits a burst
 * across a boundary; that is an accepted trade against the cost of a sliding
 * log for a limit whose job is to stop runaway loops, not to meter billing.
 */
@Injectable()
export class RedisRateLimiter implements RateLimiter {
  private readonly logger = new Logger(RedisRateLimiter.name);

  constructor(private readonly redis: Redis) {}

  async consume(input: {
    key: string;
    limitPerMinute: number;
  }): Promise<{ retryAfterSeconds: number } | null> {
    const key = `aia:tool-rate:${input.key}`;

    try {
      const replies = await this.redis.multi().incr(key).expire(key, WINDOW_SECONDS, 'NX').exec();

      const count = Number(replies?.[0]?.[1] ?? Number.NaN);
      // `exec` answers null when the transaction was discarded; treating that as
      // "no count" would silently let the call through unmetered.
      if (Number.isNaN(count)) throw new Error('the rate-limit transaction was discarded');
      if (count <= input.limitPerMinute) return null;

      const ttl = await this.redis.ttl(key);
      return { retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    } catch (error) {
      // Redis down must not become a silent removal of the rate limit, but it
      // must not stop every tool either. The router makes the same call for
      // budget: degrade loudly, keep serving.
      this.logger.error(`rate limiting is degraded: ${String(error)}`);
      return null;
    }
  }
}

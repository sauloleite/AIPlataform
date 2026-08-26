import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { IntrospectionCache } from '../../application/ports.js';

/** Short-lived introspection cache. The key is the token hash, never the token. */
@Injectable()
export class RedisIntrospectionCache implements IntrospectionCache {
  private static readonly PREFIX = 'aia:introspect:';

  constructor(private readonly redis: Redis) {}

  async get(tokenHash: string): Promise<string | null> {
    return this.redis.get(RedisIntrospectionCache.PREFIX + tokenHash);
  }

  async set(tokenHash: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(RedisIntrospectionCache.PREFIX + tokenHash, value, 'EX', ttlSeconds);
  }

  async invalidate(tokenHash: string): Promise<void> {
    await this.redis.del(RedisIntrospectionCache.PREFIX + tokenHash);
  }
}

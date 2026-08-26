import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { CachedCompletion, SemanticCache } from '../../application/ports.js';

export interface RedisCacheOptions {
  enabled: boolean;
  ttlSeconds: number;
}

/**
 * Completion cache keyed on the EXACT prompt.
 *
 * Not semantic yet: a similarity cache would require generating an embedding on
 * every request, which only pays off once there is measured volume. This version
 * already captures the common case — a repeated prompt — at no extra cost, and
 * the `SemanticCache` port keeps the swap to a vector version out of the use
 * case.
 *
 * The key includes `project_id`: without it, one project would read another's
 * answers.
 */
@Injectable()
export class RedisSemanticCache implements SemanticCache {
  constructor(
    private readonly redis: Redis,
    private readonly options: RedisCacheOptions,
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  private key(projectId: string, aliasId: string, prompt: string): string {
    const digest = createHash('sha256').update(prompt).digest('hex').slice(0, 32);
    return `aia:cache:${projectId}:${aliasId}:${digest}`;
  }

  async lookup(
    projectId: string,
    aliasId: string,
    prompt: string,
  ): Promise<CachedCompletion | null> {
    if (!this.options.enabled) return null;

    try {
      const raw = await this.redis.get(this.key(projectId, aliasId, prompt));
      return raw === null ? null : (JSON.parse(raw) as CachedCompletion);
    } catch {
      // An unavailable cache never breaks inference: it is an optimisation, not a
      // requirement.
      return null;
    }
  }

  async store(
    projectId: string,
    aliasId: string,
    prompt: string,
    completion: CachedCompletion,
  ): Promise<void> {
    if (!this.options.enabled) return;

    try {
      await this.redis.set(
        this.key(projectId, aliasId, prompt),
        JSON.stringify(completion),
        'EX',
        this.options.ttlSeconds,
      );
    } catch {
      // Same reasoning as above.
    }
  }
}

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { CachedCompletion, SemanticCache } from '../../application/ports.js';

export interface RedisCacheOptions {
  enabled: boolean;
  ttlSeconds: number;
}

/**
 * Cache de completions por chave EXATA do prompt.
 *
 * Nao e semantico ainda: um cache por similaridade de embedding exige gerar um
 * embedding a cada requisicao, o que so compensa quando ha volume medido. Esta
 * versao ja captura o caso frequente (prompt repetido) sem custo extra, e o port
 * `SemanticCache` deixa a troca para a versao vetorial sem tocar no caso de uso.
 *
 * A chave inclui o `project_id`: sem isso, um projeto leria a resposta de outro.
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
      // Cache indisponivel nunca derruba a inferencia: e otimizacao, nao requisito.
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
      // idem
    }
  }
}

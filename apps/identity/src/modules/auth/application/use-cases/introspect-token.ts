import { Inject, Injectable } from '@nestjs/common';
import { PAT_PREFIX } from '../../domain/entities/personal-access-token.js';
import {
  CLOCK,
  INTROSPECTION_CACHE,
  PAT_REPOSITORY,
  TOKEN_HASHER,
  type Clock,
  type IntrospectionCache,
  type PatRepository,
  type TokenHasher,
} from '../ports.js';
import type { IntrospectCommand, IntrospectionResult } from '../dto.js';

const INACTIVE: IntrospectionResult = { active: false };
const CACHE_TTL_SECONDS = 60;

/**
 * Introspeccao de token opaco (PAT).
 *
 * JWT nao passa por aqui: e validado localmente pelo JWKS (ADR-004). Este caso de
 * uso existe so para os clientes que nao suportam OAuth, e o cache de 60 s evita
 * que eles transformem o identity em gargalo.
 */
@Injectable()
export class IntrospectToken {
  constructor(
    @Inject(PAT_REPOSITORY) private readonly pats: PatRepository,
    @Inject(TOKEN_HASHER) private readonly hasher: TokenHasher,
    @Inject(INTROSPECTION_CACHE) private readonly cache: IntrospectionCache,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: IntrospectCommand): Promise<IntrospectionResult> {
    // Um JWT que chegue aqui por engano nao deve virar consulta ao banco.
    if (!command.token.startsWith(PAT_PREFIX)) return INACTIVE;

    // A chave do cache e o HASH, nunca o token em claro: o Redis nao guarda segredo.
    const tokenHash = this.hasher.hash(command.token);

    const cached = await this.cache.get(tokenHash);
    if (cached !== null) return JSON.parse(cached) as IntrospectionResult;

    const pat = await this.pats.findByHash(tokenHash);
    if (pat === null) return INACTIVE;

    const now = this.clock.now();
    // Nao cacheia resultado negativo: revogacao precisa valer imediatamente.
    if (pat.isRevoked || pat.isExpired(now)) return INACTIVE;

    pat.markUsed(now);
    await this.pats.save(pat);

    const result: IntrospectionResult = {
      active: true,
      sub: pat.principalId,
      scope: pat.scopes.toString(),
      exp: Math.floor(pat.toSnapshot().expiresAt.getTime() / 1000),
      projectId: pat.projectId,
      principalType: 'application',
    };

    await this.cache.set(tokenHash, JSON.stringify(result), CACHE_TTL_SECONDS);
    return result;
  }
}

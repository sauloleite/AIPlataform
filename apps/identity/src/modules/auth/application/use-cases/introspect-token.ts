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
 * Opaque token (PAT) introspection.
 *
 * A JWT never comes through here: it is validated locally against the JWKS
 * (ADR-004). This use case exists only for clients that cannot do OAuth, and the
 * 60 s cache keeps them from turning identity into a bottleneck.
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
    // A JWT that lands here by mistake must not become a database query.
    if (!command.token.startsWith(PAT_PREFIX)) return INACTIVE;

    // The cache key is the HASH, never the plaintext: Redis stores no secrets.
    const tokenHash = this.hasher.hash(command.token);

    const cached = await this.cache.get(tokenHash);
    if (cached !== null) return JSON.parse(cached) as IntrospectionResult;

    const pat = await this.pats.findByHash(tokenHash);
    if (pat === null) return INACTIVE;

    const now = this.clock.now();
    // Negative results are not cached: revocation must take effect immediately.
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

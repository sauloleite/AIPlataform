import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@aia/errors';
import { PAT_PREFIX, PersonalAccessToken } from '../../domain/entities/personal-access-token.js';
import { TokenScopes } from '../../domain/value-objects/token-scopes.js';
import {
  CLOCK,
  ID_GENERATOR,
  PAT_REPOSITORY,
  PRINCIPAL_REPOSITORY,
  TOKEN_HASHER,
  type Clock,
  type IdGenerator,
  type PatRepository,
  type PrincipalRepository,
  type TokenHasher,
} from '../ports.js';
import type { CreatePatCommand, CreatedPatResult } from '../dto.js';

@Injectable()
export class CreatePat {
  constructor(
    @Inject(PAT_REPOSITORY) private readonly pats: PatRepository,
    @Inject(PRINCIPAL_REPOSITORY) private readonly principals: PrincipalRepository,
    @Inject(TOKEN_HASHER) private readonly hasher: TokenHasher,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CreatePatCommand): Promise<CreatedPatResult> {
    const principal = await this.principals.findById(command.principalId);
    if (principal === null) throw new NotFoundError('Principal', command.principalId);
    principal.ensureCanAuthenticate();

    const secret = `${PAT_PREFIX}${this.ids.secret(32)}`;
    const pat = PersonalAccessToken.issue({
      id: this.ids.next(),
      name: command.name,
      principalId: command.principalId,
      projectId: command.projectId,
      tokenHash: this.hasher.hash(secret),
      scopes: TokenScopes.of(command.scopes),
      expiresInDays: command.expiresInDays,
      now: this.clock.now(),
    });

    await this.pats.save(pat);

    const snapshot = pat.toSnapshot();
    return {
      id: snapshot.id,
      name: snapshot.name,
      projectId: snapshot.projectId,
      scopes: snapshot.scopes.toArray(),
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      token: secret,
    };
  }
}

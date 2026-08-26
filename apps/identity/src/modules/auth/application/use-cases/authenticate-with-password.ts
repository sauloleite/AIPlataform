import { Inject, Injectable } from '@nestjs/common';
import { InvalidCredentialsError } from '../../domain/errors/index.js';
import { Email } from '../../domain/value-objects/email.js';
import { TokenScopes } from '../../domain/value-objects/token-scopes.js';
import {
  CLOCK,
  PASSWORD_HASHER,
  PRINCIPAL_REPOSITORY,
  TOKEN_SIGNER,
  type Clock,
  type PasswordHasher,
  type PrincipalRepository,
  type TokenSigner,
} from '../ports.js';
import type { AuthenticateWithPasswordCommand, IssuedTokenResult } from '../dto.js';

@Injectable()
export class AuthenticateWithPassword {
  constructor(
    @Inject(PRINCIPAL_REPOSITORY) private readonly principals: PrincipalRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    command: AuthenticateWithPasswordCommand,
    ttlSeconds: number,
  ): Promise<IssuedTokenResult> {
    const principal = await this.principals.findByEmail(Email.of(command.email));

    // Verify the password even with no principal, against a throwaway hash, so
    // response time cannot reveal whether the account exists (timing attack).
    const hash = principal?.passwordHash ?? '$argon2id$v=19$m=4,t=1,p=1$YWFhYWFhYWE$invalid';
    const passwordMatches = await this.hasher.verify(hash, command.password);

    if (principal === null || !passwordMatches) throw new InvalidCredentialsError();
    principal.ensureCanAuthenticate();

    const granted = TokenScopes.all().intersect(
      command.requestedScopes === undefined
        ? TokenScopes.all()
        : TokenScopes.of(command.requestedScopes),
    );

    const signed = await this.signer.sign(
      {
        sub: principal.id,
        principal_type: principal.type,
        ...(principal.email !== undefined && { email: principal.email.value }),
        ...(principal.displayName !== undefined && { name: principal.displayName }),
        roles: [...principal.globalRoles],
        memberships: principal.memberships.map((m) => ({
          project_id: m.projectId,
          roles: m.roles,
        })),
        scope: granted.toString(),
      },
      ttlSeconds,
    );

    return {
      accessToken: signed.token,
      tokenType: 'Bearer',
      expiresIn: Math.max(
        0,
        Math.floor((signed.expiresAt.getTime() - this.clock.now().getTime()) / 1000),
      ),
      scope: granted.toString(),
    };
  }
}

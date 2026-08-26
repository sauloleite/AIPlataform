import { Inject, Injectable } from '@nestjs/common';
import { InvalidCredentialsError } from '../../domain/errors/index.js';
import { TokenScopes } from '../../domain/value-objects/token-scopes.js';
import {
  CLOCK,
  SERVICE_CLIENT_REPOSITORY,
  TOKEN_SIGNER,
  type Clock,
  type ServiceClientRepository,
  type TokenSigner,
} from '../ports.js';
import type { IssuedTokenResult } from '../dto.js';

export interface AuthenticateClientCommand {
  clientId: string;
  clientSecret: string;
  requestedScopes?: string[];
}

/**
 * The `client_credentials` grant: a service authenticates as itself.
 *
 * The resulting token carries `principal_type: service` and NO memberships: it
 * acts on nobody's behalf and belongs to no project. Each consumer decides what a
 * service may do — governance, for instance, lets a service read any project's
 * policy, which a user cannot.
 */
@Injectable()
export class AuthenticateClient {
  constructor(
    @Inject(SERVICE_CLIENT_REPOSITORY) private readonly clients: ServiceClientRepository,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    command: AuthenticateClientCommand,
    ttlSeconds: number,
  ): Promise<IssuedTokenResult> {
    const client = await this.clients.findByClientId(command.clientId);
    // A service secret is high entropy and compared through a deterministic
    // hash; the constant-time comparison lives in the hasher itself.
    if (client === null || !this.clients.matches(client, command.clientSecret)) {
      throw new InvalidCredentialsError();
    }
    client.ensureEnabled();

    const granted =
      command.requestedScopes === undefined
        ? client.scopes
        : client.scopes.intersect(TokenScopes.of(command.requestedScopes));

    const signed = await this.signer.sign(
      {
        sub: client.clientId,
        principal_type: 'service',
        name: client.displayName,
        roles: [],
        memberships: [],
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

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
 * Grant `client_credentials`: um servico se autentica como ele mesmo.
 *
 * O token resultante tem `principal_type: service` e NENHUMA membership: ele nao
 * age em nome de um usuario nem pertence a um projeto. Quem consome decide o que
 * um servico pode fazer (o governance, por exemplo, deixa um servico ler a
 * politica de qualquer projeto, o que um usuario nao pode).
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
    // Segredo de servico tem alta entropia e e comparado por hash deterministico;
    // a comparacao em tempo constante fica no proprio hasher.
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

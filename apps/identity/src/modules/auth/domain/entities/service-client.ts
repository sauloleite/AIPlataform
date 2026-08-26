import { ValidationError } from '@aia/errors';
import { type TokenScopes } from '../value-objects/token-scopes.js';
import { InvalidCredentialsError } from '../errors/index.js';

export interface ServiceClientProps {
  clientId: string;
  displayName: string;
  /** Somente o hash. O segredo em claro so existe na configuracao do servico. */
  secretHash: string;
  scopes: TokenScopes;
  enabled: boolean;
  createdAt: Date;
}

/**
 * Identidade de um SERVICO da plataforma.
 *
 * Sem uma nuvem que forneca identidade gerenciada, o proprio identity emite a
 * credencial de servico (doc 02, secao 6). Um token de servico e diferente de um
 * token de usuario: nao pertence a projeto nenhum, e por isso o governance o
 * aceita para ler a politica de qualquer projeto — sem isso, o router precisaria
 * repassar o token do usuario final, e uma chamada de sistema (reconciliacao,
 * worker) ficaria sem como se autenticar.
 */
export class ServiceClient {
  private constructor(private props: ServiceClientProps) {}

  static rehydrate(props: ServiceClientProps): ServiceClient {
    return new ServiceClient(props);
  }

  static register(input: {
    clientId: string;
    displayName: string;
    secretHash: string;
    scopes: TokenScopes;
    now?: Date;
  }): ServiceClient {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(input.clientId)) {
      throw new ValidationError('client_id deve ser minusculo, com 3 a 64 caracteres', {
        client_id: input.clientId,
      });
    }
    return new ServiceClient({
      clientId: input.clientId,
      displayName: input.displayName,
      secretHash: input.secretHash,
      scopes: input.scopes,
      enabled: true,
      createdAt: input.now ?? new Date(),
    });
  }

  get clientId(): string {
    return this.props.clientId;
  }

  get displayName(): string {
    return this.props.displayName;
  }

  get secretHash(): string {
    return this.props.secretHash;
  }

  get scopes(): TokenScopes {
    return this.props.scopes;
  }

  get enabled(): boolean {
    return this.props.enabled;
  }

  ensureEnabled(): void {
    if (!this.props.enabled) throw new InvalidCredentialsError();
  }

  rotateSecret(secretHash: string): void {
    this.props.secretHash = secretHash;
  }

  disable(): void {
    this.props.enabled = false;
  }

  toSnapshot(): ServiceClientProps {
    return { ...this.props };
  }
}

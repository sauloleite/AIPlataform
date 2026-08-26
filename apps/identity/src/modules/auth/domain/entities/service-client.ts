import { ValidationError } from '@aia/errors';
import { type TokenScopes } from '../value-objects/token-scopes.js';
import { InvalidCredentialsError } from '../errors/index.js';

export interface ServiceClientProps {
  clientId: string;
  displayName: string;
  /** Hash only. The plaintext secret lives solely in the service's configuration. */
  secretHash: string;
  scopes: TokenScopes;
  enabled: boolean;
  createdAt: Date;
}

/**
 * Identity of a platform SERVICE.
 *
 * With no cloud providing managed identity, the identity service issues the
 * service credential itself (reference doc 02 §6). A service token differs from
 * a user token: it belongs to no project, which is why governance accepts it to
 * read any project's policy. Without it the router would have to forward the end
 * user's token, and a system-initiated call (reconciliation, a worker) would
 * have no way to authenticate at all.
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
      throw new ValidationError('client_id must be lowercase, 3 to 64 characters', {
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

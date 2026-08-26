import { ValidationError } from '@aia/errors';
import { PatExpiredError, PatRevokedError } from '../errors/index.js';
import { type TokenScopes } from '../value-objects/token-scopes.js';

export interface PatProps {
  id: string;
  name: string;
  principalId: string;
  projectId: string;
  /** Somente o hash e persistido. O valor em claro existe uma unica vez. */
  tokenHash: string;
  scopes: TokenScopes;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export const PAT_PREFIX = 'aia_pat_';
const MAX_LIFETIME_DAYS = 365;

/**
 * Token opaco, para clientes que nao falam OAuth (doc 02, principio 5).
 *
 * Diferente do JWT, exige introspeccao — por isso tem cache de 60 s e prazo
 * de validade limitado.
 */
export class PersonalAccessToken {
  private constructor(private props: PatProps) {}

  static rehydrate(props: PatProps): PersonalAccessToken {
    return new PersonalAccessToken(props);
  }

  static issue(input: {
    id: string;
    name: string;
    principalId: string;
    projectId: string;
    tokenHash: string;
    scopes: TokenScopes;
    expiresInDays: number;
    now?: Date;
  }): PersonalAccessToken {
    if (input.expiresInDays < 1 || input.expiresInDays > MAX_LIFETIME_DAYS) {
      throw new ValidationError(
        `Validade deve ficar entre 1 e ${MAX_LIFETIME_DAYS.toString()} dias`,
        {
          expires_in_days: input.expiresInDays,
        },
      );
    }
    if (input.scopes.isEmpty) {
      throw new ValidationError('Um PAT sem escopo nao serve para nada');
    }

    const now = input.now ?? new Date();
    return new PersonalAccessToken({
      id: input.id,
      name: input.name,
      principalId: input.principalId,
      projectId: input.projectId,
      tokenHash: input.tokenHash,
      scopes: input.scopes,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000),
    });
  }

  get id(): string {
    return this.props.id;
  }

  get principalId(): string {
    return this.props.principalId;
  }

  get projectId(): string {
    return this.props.projectId;
  }

  get scopes(): TokenScopes {
    return this.props.scopes;
  }

  get tokenHash(): string {
    return this.props.tokenHash;
  }

  get isRevoked(): boolean {
    return this.props.revokedAt !== undefined;
  }

  isExpired(now: Date = new Date()): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  /** Lanca o erro tipado correspondente se o token nao puder ser usado. */
  ensureUsable(now: Date = new Date()): void {
    if (this.isRevoked) throw new PatRevokedError();
    if (this.isExpired(now)) throw new PatExpiredError();
  }

  markUsed(now: Date = new Date()): void {
    this.props.lastUsedAt = now;
  }

  revoke(now: Date = new Date()): void {
    this.props.revokedAt ??= now;
  }

  toSnapshot(): PatProps {
    return { ...this.props };
  }
}

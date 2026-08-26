import { ValidationError } from '@aia/errors';
import { PatExpiredError, PatRevokedError } from '../errors/index.js';
import { type TokenScopes } from '../value-objects/token-scopes.js';

export interface PatProps {
  id: string;
  name: string;
  principalId: string;
  projectId: string;
  /** Only the hash is persisted. The plaintext exists exactly once. */
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
 * Opaque token, for clients that do not speak OAuth (doc 02, principle 5).
 *
 * Unlike a JWT it requires introspection — hence the 60 s cache and the capped
 * lifetime.
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
      throw new ValidationError('A PAT with no scope is useless');
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

  /** Throws the matching typed error if the token cannot be used. */
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

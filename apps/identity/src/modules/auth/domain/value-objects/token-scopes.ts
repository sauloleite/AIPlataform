import { ValidationError } from '@aia/errors';

/** Known scopes. Anything outside this list is rejected at issuance. */
export const KNOWN_SCOPES = [
  'inference:read',
  'inference:write',
  'projects:read',
  'projects:write',
  'assets:read',
  'assets:write',
  'audit:read',
] as const;

export type KnownScope = (typeof KNOWN_SCOPES)[number];

export class TokenScopes {
  private constructor(private readonly scopes: readonly string[]) {}

  static of(raw: readonly string[]): TokenScopes {
    const unknown = raw.filter((scope) => !KNOWN_SCOPES.includes(scope as KnownScope));
    if (unknown.length > 0) {
      throw new ValidationError('Unknown scope', { scopes: unknown });
    }
    return new TokenScopes([...new Set(raw)].sort());
  }

  static all(): TokenScopes {
    return new TokenScopes([...KNOWN_SCOPES]);
  }

  /** A token can never hold more scope than whoever requested it. */
  intersect(other: TokenScopes): TokenScopes {
    return new TokenScopes(this.scopes.filter((scope) => other.scopes.includes(scope)));
  }

  contains(scope: string): boolean {
    return this.scopes.includes(scope);
  }

  toArray(): string[] {
    return [...this.scopes];
  }

  toString(): string {
    return this.scopes.join(' ');
  }

  get isEmpty(): boolean {
    return this.scopes.length === 0;
  }
}

import { ValidationError } from '@aia/errors';

/** Escopos conhecidos. Um escopo fora desta lista e recusado na emissao. */
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
      throw new ValidationError('Escopo desconhecido', { scopes: unknown });
    }
    return new TokenScopes([...new Set(raw)].sort());
  }

  static all(): TokenScopes {
    return new TokenScopes([...KNOWN_SCOPES]);
  }

  /** Um token nunca pode ter mais escopo do que quem o pediu. */
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

import { createHash } from 'node:crypto';
import type {
  Clock,
  IdGenerator,
  IntrospectionCache,
  PasswordHasher,
  PatRepository,
  PrincipalRepository,
  SignedToken,
  TokenHasher,
  TokenSigner,
} from '../../src/modules/auth/application/ports.js';
import type { PersonalAccessToken } from '../../src/modules/auth/domain/entities/personal-access-token.js';
import type { PrincipalEntity } from '../../src/modules/auth/domain/entities/principal.js';
import type { Email } from '../../src/modules/auth/domain/value-objects/email.js';

/**
 * Fakes, nao mocks (doc 03, secao 7).
 *
 * Cumprem o contrato de verdade, entao o teste verifica COMPORTAMENTO em vez de
 * amarrar-se a quais metodos foram chamados e em que ordem.
 */

export class FakePrincipalRepository implements PrincipalRepository {
  private readonly byId = new Map<string, PrincipalEntity>();

  async findById(id: string): Promise<PrincipalEntity | null> {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(email: Email): Promise<PrincipalEntity | null> {
    for (const principal of this.byId.values()) {
      if (principal.email?.value === email.value) return principal;
    }
    return null;
  }

  async save(principal: PrincipalEntity): Promise<void> {
    this.byId.set(principal.id, principal);
  }
}

export class FakePatRepository implements PatRepository {
  readonly saved: PersonalAccessToken[] = [];
  private readonly byHash = new Map<string, PersonalAccessToken>();
  private readonly byId = new Map<string, PersonalAccessToken>();

  async findById(id: string): Promise<PersonalAccessToken | null> {
    return this.byId.get(id) ?? null;
  }

  async findByHash(tokenHash: string): Promise<PersonalAccessToken | null> {
    return this.byHash.get(tokenHash) ?? null;
  }

  async listByPrincipal(
    principalId: string,
    limit: number,
  ): Promise<{ items: PersonalAccessToken[]; nextCursor: string | null }> {
    const items = [...this.byId.values()].filter((pat) => pat.principalId === principalId);
    return { items: items.slice(0, limit), nextCursor: null };
  }

  async save(pat: PersonalAccessToken): Promise<void> {
    this.saved.push(pat);
    this.byId.set(pat.id, pat);
    this.byHash.set(pat.tokenHash, pat);
  }
}

/** Hash reversivel e deterministico: o teste precisa ser previsivel, nao seguro. */
export class FakePasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `hashed:${plain}`;
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    return hash === `hashed:${plain}`;
  }
}

/**
 * SHA-256 de verdade, e nao um prefixo: um fake que embutisse o token no hash
 * tornaria vazia a assercao de que o valor em claro nao e persistido.
 */
export class FakeTokenHasher implements TokenHasher {
  hash(token: string): string {
    return createHash('sha256').update(`fake-pepper:${token}`).digest('hex');
  }
}

export class FakeTokenSigner implements TokenSigner {
  readonly signed: { claims: Record<string, unknown>; ttlSeconds: number }[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async sign(claims: Record<string, unknown>, ttlSeconds: number): Promise<SignedToken> {
    this.signed.push({ claims, ttlSeconds });
    return {
      token: `fake.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`,
      expiresAt: new Date(this.now().getTime() + ttlSeconds * 1000),
    };
  }

  async publicJwks(): Promise<{ keys: unknown[] }> {
    return { keys: [{ kid: 'fake' }] };
  }

  lastClaims(): Record<string, unknown> | undefined {
    return this.signed.at(-1)?.claims;
  }
}

export class FakeIntrospectionCache implements IntrospectionCache {
  private readonly entries = new Map<string, string>();
  hits = 0;

  async get(tokenHash: string): Promise<string | null> {
    const value = this.entries.get(tokenHash) ?? null;
    if (value !== null) this.hits += 1;
    return value;
  }

  async set(tokenHash: string, value: string): Promise<void> {
    this.entries.set(tokenHash, value);
  }

  async invalidate(tokenHash: string): Promise<void> {
    this.entries.delete(tokenHash);
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `id-${this.counter.toString()}`;
  }

  secret(bytes: number): string {
    return 's'.repeat(bytes);
  }
}

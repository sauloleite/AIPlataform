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
 * Fakes, not mocks (reference doc 03 §7).
 *
 * They honour the contract for real, so the test checks BEHAVIOUR rather than
 * binding itself to which methods were called and in what order.
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

/** Reversible, deterministic hash: the test needs predictability, not security. */
export class FakePasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `hashed:${plain}`;
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    return hash === `hashed:${plain}`;
  }
}

/**
 * A real SHA-256 rather than a prefix: a fake that embedded the token inside the
 * hash would make the assertion about plaintext never being persisted vacuous.
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

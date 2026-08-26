import type { PersonalAccessToken } from '../domain/entities/personal-access-token.js';
import type { ServiceClient } from '../domain/entities/service-client.js';
import type { PrincipalEntity } from '../domain/entities/principal.js';
import type { Email } from '../domain/value-objects/email.js';

/**
 * Application layer ports.
 *
 * Interfaces, never concrete classes: the use case does not know whether MongoDB,
 * Redis or memory sits behind them. The Symbols exist because NestJS needs an
 * injection token at runtime, and an interface disappears at compile time.
 */

export interface PrincipalRepository {
  findById(id: string): Promise<PrincipalEntity | null>;
  findByEmail(email: Email): Promise<PrincipalEntity | null>;
  save(principal: PrincipalEntity): Promise<void>;
}
export const PRINCIPAL_REPOSITORY = Symbol('PrincipalRepository');

export interface ServiceClientRepository {
  findByClientId(clientId: string): Promise<ServiceClient | null>;
  save(client: ServiceClient): Promise<void>;
  /** Compares the presented secret against the stored hash, in constant time. */
  matches(client: ServiceClient, presentedSecret: string): boolean;
}
export const SERVICE_CLIENT_REPOSITORY = Symbol('ServiceClientRepository');

export interface PatRepository {
  findById(id: string): Promise<PersonalAccessToken | null>;
  findByHash(tokenHash: string): Promise<PersonalAccessToken | null>;
  listByPrincipal(
    principalId: string,
    limit: number,
    cursor?: string,
  ): Promise<{
    items: PersonalAccessToken[];
    nextCursor: string | null;
  }>;
  save(pat: PersonalAccessToken): Promise<void>;
}
export const PAT_REPOSITORY = Symbol('PatRepository');

/**
 * PASSWORD hashing. Slow and randomly salted by design (Argon2id).
 * Every `hash` call yields a different value: always use `verify`.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}
export const PASSWORD_HASHER = Symbol('PasswordHasher');

/**
 * OPAQUE TOKEN hashing. Deterministic, because the token has to be found by an
 * indexed lookup — a random salt would make that query impossible.
 *
 * A fast hash is safe here precisely because a PAT is not a password: it is 32
 * random bytes, with no search space worth brute forcing. The server pepper
 * stops a database leak from turning into usable tokens.
 */
export interface TokenHasher {
  hash(token: string): string;
}
export const TOKEN_HASHER = Symbol('TokenHasher');

export interface SignedToken {
  token: string;
  expiresAt: Date;
}

export interface TokenSigner {
  sign(claims: Record<string, unknown>, ttlSeconds: number): Promise<SignedToken>;
  /** Public keys for the JWKS endpoint. */
  publicJwks(): Promise<{ keys: unknown[] }>;
}
export const TOKEN_SIGNER = Symbol('TokenSigner');

/** Short-lived cache for PAT introspection (ADR-004). */
export interface IntrospectionCache {
  get(tokenHash: string): Promise<string | null>;
  set(tokenHash: string, value: string, ttlSeconds: number): Promise<void>;
  invalidate(tokenHash: string): Promise<void>;
}
export const INTROSPECTION_CACHE = Symbol('IntrospectionCache');

export interface IdGenerator {
  next(): string;
  /** A secret with enough entropy to serve as a PAT. */
  secret(bytes: number): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

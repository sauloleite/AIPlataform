import type { PersonalAccessToken } from '../domain/entities/personal-access-token.js';
import type { ServiceClient } from '../domain/entities/service-client.js';
import type { PrincipalEntity } from '../domain/entities/principal.js';
import type { Email } from '../domain/value-objects/email.js';

/**
 * Ports da camada de aplicacao.
 *
 * Interfaces, nunca classes concretas: o caso de uso nao sabe se por tras ha
 * MongoDB, Redis ou memoria. Os Symbol existem porque o NestJS precisa de um
 * token de injecao em runtime, e interface some na compilacao.
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
  /** Compara o segredo apresentado com o hash guardado, em tempo constante. */
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
 * Hash de SENHA. Lento e com salt aleatorio por design (Argon2id).
 * Cada chamada de `hash` produz um valor diferente: sempre use `verify`.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}
export const PASSWORD_HASHER = Symbol('PasswordHasher');

/**
 * Hash de TOKEN OPACO. Deterministico, porque o token precisa ser encontrado
 * por busca indexada — um salt aleatorio tornaria a consulta impossivel.
 *
 * Usar hash rapido aqui e seguro justamente porque um PAT nao e uma senha:
 * sao 32 bytes aleatorios, sem espaco de busca que compense forca bruta.
 * O pepper do servidor impede que um vazamento do banco vire tokens validos.
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
  /** Chaves publicas para o endpoint JWKS. */
  publicJwks(): Promise<{ keys: unknown[] }>;
}
export const TOKEN_SIGNER = Symbol('TokenSigner');

/** Cache curto para introspeccao de PAT (ADR-004). */
export interface IntrospectionCache {
  get(tokenHash: string): Promise<string | null>;
  set(tokenHash: string, value: string, ttlSeconds: number): Promise<void>;
  invalidate(tokenHash: string): Promise<void>;
}
export const INTROSPECTION_CACHE = Symbol('IntrospectionCache');

export interface IdGenerator {
  next(): string;
  /** Segredo com entropia suficiente para virar um PAT. */
  secret(bytes: number): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

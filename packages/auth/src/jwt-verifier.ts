import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { UnauthenticatedError, ERROR_CODES, DomainError, type ErrorCode } from '@aia/errors';
import {
  ROLES,
  type Principal,
  type PrincipalType,
  type ProjectMembership,
  type Role,
} from './principal.js';

export class TokenExpiredError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOKEN_EXPIRED;
  readonly status = 401;
  constructor() {
    super('Token expirado');
  }
}

export class InvalidTokenError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.INVALID_TOKEN;
  readonly status = 401;
  constructor(reason: string) {
    super('Token invalido', { reason });
  }
}

/** Claims que a plataforma espera no token, alem das registradas do JWT. */
interface AiaClaims extends JWTPayload {
  principal_type?: string;
  email?: string;
  name?: string;
  roles?: unknown;
  memberships?: unknown;
  scope?: string;
  scp?: string;
}

export interface JwtVerifierOptions {
  /** Emissor esperado. Token de outro emissor e recusado. */
  issuer: string;
  /** URL do JWKS. As chaves publicas ficam em cache e sao recarregadas sozinhas. */
  jwksUri: string;
  audience?: string;
  /** Tolerancia de relogio entre servicos, em segundos. */
  clockToleranceSeconds?: number;
  /** Injetavel nos testes; em producao o padrao busca o JWKS remoto. */
  getKey?: JWTVerifyGetKey;
}

const VALID_PRINCIPAL_TYPES: readonly PrincipalType[] = ['user', 'application', 'service'];
const VALID_ROLES: readonly string[] = Object.values(ROLES);

function parseRoles(value: unknown): Role[] {
  if (!Array.isArray(value)) return [];
  // Um papel desconhecido e descartado, nao aceito: evita escalada por claim forjada
  // num emissor externo mal configurado.
  return value.filter(
    (role): role is Role => typeof role === 'string' && VALID_ROLES.includes(role),
  );
}

function parseMemberships(value: unknown): ProjectMembership[] {
  if (!Array.isArray(value)) return [];
  const memberships: ProjectMembership[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const projectId = record['project_id'] ?? record['projectId'];
    if (typeof projectId !== 'string' || projectId === '') continue;
    memberships.push({ projectId, roles: parseRoles(record['roles']) });
  }
  return memberships;
}

function parseScopes(claims: AiaClaims): string[] {
  const raw = claims.scope ?? claims.scp ?? '';
  return raw.split(' ').filter((scope) => scope !== '');
}

/**
 * Validacao local de JWT (ADR-004).
 *
 * Nenhuma chamada de rede no caminho critico: as chaves publicas vem do JWKS e
 * ficam em cache. O servico de identidade sai do caminho da maioria das requests.
 */
export class JwtVerifier {
  private readonly getKey: JWTVerifyGetKey;

  constructor(private readonly options: JwtVerifierOptions) {
    this.getKey =
      options.getKey ??
      createRemoteJWKSet(new URL(options.jwksUri), {
        cacheMaxAge: 10 * 60 * 1000,
        cooldownDuration: 30 * 1000,
      });
  }

  async verify(token: string): Promise<Principal> {
    let payload: AiaClaims;
    try {
      const result = await jwtVerify<AiaClaims>(token, this.getKey, {
        issuer: this.options.issuer,
        ...(this.options.audience !== undefined && { audience: this.options.audience }),
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
      });
      payload = result.payload;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWT_EXPIRED') throw new TokenExpiredError();
      throw new InvalidTokenError(code ?? 'assinatura ou claims invalidas');
    }

    if (payload.sub === undefined || payload.sub === '') {
      throw new InvalidTokenError('claim sub ausente');
    }
    if (payload.exp === undefined) {
      throw new InvalidTokenError('claim exp ausente: token sem validade e recusado');
    }

    const principalType = VALID_PRINCIPAL_TYPES.includes(payload.principal_type as PrincipalType)
      ? (payload.principal_type as PrincipalType)
      : 'user';

    return {
      id: payload.sub,
      type: principalType,
      ...(typeof payload.email === 'string' && { email: payload.email }),
      ...(typeof payload.name === 'string' && { displayName: payload.name }),
      globalRoles: parseRoles(payload.roles),
      memberships: parseMemberships(payload.memberships),
      scopes: parseScopes(payload),
      issuer: this.options.issuer,
      expiresAt: new Date(payload.exp * 1000),
    };
  }
}

/** Extrai o token do header Authorization. */
export function bearerToken(authorizationHeader: string | undefined): string {
  if (authorizationHeader === undefined || authorizationHeader === '') {
    throw new UnauthenticatedError('Header Authorization ausente');
  }
  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token === '') {
    throw new UnauthenticatedError('Esperado o esquema Bearer no header Authorization');
  }
  return token;
}

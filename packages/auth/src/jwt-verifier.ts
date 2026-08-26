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
    super('Token expired');
  }
}

export class InvalidTokenError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.INVALID_TOKEN;
  readonly status = 401;
  constructor(reason: string) {
    super('Invalid token', { reason });
  }
}

/** Claims the platform expects on the token, beyond the registered JWT ones. */
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
  /** Expected issuer. A token from any other issuer is rejected. */
  issuer: string;
  /** JWKS URL. Public keys are cached and refreshed automatically. */
  jwksUri: string;
  audience?: string;
  /** Clock skew tolerance between services, in seconds. */
  clockToleranceSeconds?: number;
  /** Injectable in tests; in production the default fetches the remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

const VALID_PRINCIPAL_TYPES: readonly PrincipalType[] = ['user', 'application', 'service'];
const VALID_ROLES: readonly string[] = Object.values(ROLES);

function parseRoles(value: unknown): Role[] {
  if (!Array.isArray(value)) return [];
  // An unknown role is discarded rather than accepted: this prevents privilege
  // escalation through a forged claim from a misconfigured external issuer.
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
 * Local JWT validation (ADR-004).
 *
 * No network call on the critical path: public keys come from the JWKS and stay
 * cached. The identity service leaves the path of most requests.
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
      throw new InvalidTokenError(code ?? 'invalid signature or claims');
    }

    if (payload.sub === undefined || payload.sub === '') {
      throw new InvalidTokenError('missing sub claim');
    }
    if (payload.exp === undefined) {
      throw new InvalidTokenError('missing exp claim: a token without expiry is rejected');
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

/** Extracts the token from the Authorization header. */
export function bearerToken(authorizationHeader: string | undefined): string {
  if (authorizationHeader === undefined || authorizationHeader === '') {
    throw new UnauthenticatedError('Missing Authorization header');
  }
  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token === '') {
    throw new UnauthenticatedError('Expected the Bearer scheme in the Authorization header');
  }
  return token;
}

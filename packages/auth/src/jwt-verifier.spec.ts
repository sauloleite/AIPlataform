import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { UnauthenticatedError } from '@aia/errors';
import { InvalidTokenError, JwtVerifier, TokenExpiredError, bearerToken } from './jwt-verifier.js';
import { ROLES } from './principal.js';

const ISSUER = 'http://identity:3001';
const AUDIENCE = 'aia-platform';

let privateKey: KeyLike;
let jwks: { keys: JWK[] };

async function sign(claims: Record<string, unknown>, expiresIn = '1h'): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

function verifier(): JwtVerifier {
  return new JwtVerifier({
    issuer: ISSUER,
    jwksUri: `${ISSUER}/.well-known/jwks.json`,
    audience: AUDIENCE,
    getKey: createLocalJWKSet(jwks),
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' }] };
});

describe('JwtVerifier', () => {
  it('builds the Principal from the claims', async () => {
    const token = await sign({
      sub: 'user-42',
      email: 'ana@bank.example',
      name: 'Ana',
      principal_type: 'user',
      roles: [ROLES.AUDITOR],
      memberships: [{ project_id: 'proj-1', roles: [ROLES.PROJECT_OWNER] }],
      scope: 'inference:write inference:read',
    });

    const principal = await verifier().verify(token);

    expect(principal).toMatchObject({
      id: 'user-42',
      type: 'user',
      email: 'ana@bank.example',
      globalRoles: [ROLES.AUDITOR],
      memberships: [{ projectId: 'proj-1', roles: [ROLES.PROJECT_OWNER] }],
      scopes: ['inference:write', 'inference:read'],
      issuer: ISSUER,
    });
  });

  it('discards a role missing from the catalogue instead of accepting it', async () => {
    const token = await sign({ sub: 'user-1', roles: ['superuser', ROLES.PROJECT_VIEWER] });
    const principal = await verifier().verify(token);
    expect(principal.globalRoles).toEqual([ROLES.PROJECT_VIEWER]);
  });

  it('rejects an expired token with a typed error', async () => {
    // Beyond the 5 s clock skew tolerance configured by default.
    const token = await sign({ sub: 'user-1' }, '-1h');
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('rejects a token from another issuer', async () => {
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer('http://attacker')
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(privateKey);

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token issued for a different audience', async () => {
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience('other-system')
      .setExpirationTime('1h')
      .sign(privateKey);

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'attacker-key' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(other.privateKey);

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a membership without project_id instead of creating an empty tenant', async () => {
    const token = await sign({
      sub: 'user-1',
      memberships: [{ roles: [ROLES.PROJECT_OWNER] }, { project_id: 'proj-2', roles: [] }],
    });
    const principal = await verifier().verify(token);
    expect(principal.memberships).toEqual([{ projectId: 'proj-2', roles: [] }]);
  });
});

describe('bearerToken', () => {
  it('extracts the token from the header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it.each([undefined, '', 'abc.def.ghi', 'Basic dXNlcjpwYXNz', 'Bearer '])(
    'rejects the header %p',
    (header) => {
      expect(() => bearerToken(header)).toThrow(UnauthenticatedError);
    },
  );
});

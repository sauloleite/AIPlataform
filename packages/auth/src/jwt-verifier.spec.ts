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
  it('monta o Principal a partir das claims', async () => {
    const token = await sign({
      sub: 'user-42',
      email: 'ana@banco.com',
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
      email: 'ana@banco.com',
      globalRoles: [ROLES.AUDITOR],
      memberships: [{ projectId: 'proj-1', roles: [ROLES.PROJECT_OWNER] }],
      scopes: ['inference:write', 'inference:read'],
      issuer: ISSUER,
    });
  });

  it('descarta papel que nao existe no catalogo, em vez de aceitar', async () => {
    const token = await sign({ sub: 'user-1', roles: ['superusuario', ROLES.PROJECT_VIEWER] });
    const principal = await verifier().verify(token);
    expect(principal.globalRoles).toEqual([ROLES.PROJECT_VIEWER]);
  });

  it('recusa token expirado com erro tipado', async () => {
    // Alem da tolerancia de relogio de 5 s configurada por padrao.
    const token = await sign({ sub: 'user-1' }, '-1h');
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('recusa token de outro emissor', async () => {
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer('http://atacante')
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(privateKey);

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('recusa token para outra audiencia', async () => {
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience('outro-sistema')
      .setExpirationTime('1h')
      .sign(privateKey);

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('recusa token assinado por chave desconhecida', async () => {
    const other = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'chave-do-atacante' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(other.privateKey);

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('recusa membership sem project_id em vez de criar tenant vazio', async () => {
    const token = await sign({
      sub: 'user-1',
      memberships: [{ roles: [ROLES.PROJECT_OWNER] }, { project_id: 'proj-2', roles: [] }],
    });
    const principal = await verifier().verify(token);
    expect(principal.memberships).toEqual([{ projectId: 'proj-2', roles: [] }]);
  });
});

describe('bearerToken', () => {
  it('extrai o token do header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it.each([undefined, '', 'abc.def.ghi', 'Basic dXNlcjpwYXNz', 'Bearer '])(
    'recusa o header %p',
    (header) => {
      expect(() => bearerToken(header)).toThrow(UnauthenticatedError);
    },
  );
});

import { beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '@aia/auth';
import { ValidationError } from '@aia/errors';
import { AuthenticateWithPassword } from '../src/modules/auth/application/use-cases/authenticate-with-password.js';
import { PrincipalEntity } from '../src/modules/auth/domain/entities/principal.js';
import { Email } from '../src/modules/auth/domain/value-objects/email.js';
import {
  InvalidCredentialsError,
  PrincipalDisabledError,
} from '../src/modules/auth/domain/errors/index.js';
import {
  FakePasswordHasher,
  FakePrincipalRepository,
  FakeTokenSigner,
  FixedClock,
} from './fakes/index.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const TTL = 3600;

describe('AuthenticateWithPassword', () => {
  let principals: FakePrincipalRepository;
  let signer: FakeTokenSigner;
  let useCase: AuthenticateWithPassword;

  beforeEach(async () => {
    principals = new FakePrincipalRepository();
    signer = new FakeTokenSigner(() => NOW);
    const clock = new FixedClock(NOW);
    const hasher = new FakePasswordHasher();

    useCase = new AuthenticateWithPassword(principals, hasher, signer, clock);

    const ana = PrincipalEntity.createUser({
      id: 'user-ana',
      email: Email.of('ana@bank.example'),
      displayName: 'Ana',
      passwordHash: await hasher.hash('correct-password'),
      globalRoles: [ROLES.AUDITOR],
    });
    ana.joinProject('proj-1', [ROLES.PROJECT_OWNER]);
    await principals.save(ana);
  });

  it('issues a token with roles and memberships in the claims', async () => {
    const result = await useCase.execute(
      { email: 'ana@bank.example', password: 'correct-password' },
      TTL,
    );

    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(TTL);
    expect(signer.lastClaims()).toMatchObject({
      sub: 'user-ana',
      principal_type: 'user',
      email: 'ana@bank.example',
      roles: [ROLES.AUDITOR],
      memberships: [{ project_id: 'proj-1', roles: [ROLES.PROJECT_OWNER] }],
    });
  });

  it('normalises the email: case and spaces do not block sign-in', async () => {
    await expect(
      useCase.execute({ email: '  ANA@Bank.Example ', password: 'correct-password' }, TTL),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('rejects a wrong password', async () => {
    await expect(
      useCase.execute({ email: 'ana@bank.example', password: 'wrong' }, TTL),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('gives the same answer for a nonexistent user, so accounts cannot be enumerated', async () => {
    const inexistente = await useCase
      .execute({ email: 'nobody@bank.example', password: 'anything' }, TTL)
      .catch((error: unknown) => error);
    const senhaErrada = await useCase
      .execute({ email: 'ana@bank.example', password: 'wrong' }, TTL)
      .catch((error: unknown) => error);

    expect(inexistente).toBeInstanceOf(InvalidCredentialsError);
    expect((inexistente as Error).message).toBe((senhaErrada as Error).message);
  });

  it('rejects a disabled principal even with the right password', async () => {
    const ana = await principals.findByEmail(Email.of('ana@bank.example'));
    ana?.disable();

    await expect(
      useCase.execute({ email: 'ana@bank.example', password: 'correct-password' }, TTL),
    ).rejects.toBeInstanceOf(PrincipalDisabledError);
  });

  it('limits scopes to those requested', async () => {
    const result = await useCase.execute(
      {
        email: 'ana@bank.example',
        password: 'correct-password',
        requestedScopes: ['inference:read'],
      },
      TTL,
    );
    expect(result.scope).toBe('inference:read');
  });

  it('rejects an unknown scope instead of silently dropping it', async () => {
    await expect(
      useCase.execute(
        {
          email: 'ana@bank.example',
          password: 'correct-password',
          requestedScopes: ['everything:*'],
        },
        TTL,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a malformed email before touching the repository', async () => {
    await expect(
      useCase.execute({ email: 'not-an-email', password: 'x' }, TTL),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

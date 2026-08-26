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
      email: Email.of('ana@banco.com'),
      displayName: 'Ana',
      passwordHash: await hasher.hash('senha-correta'),
      globalRoles: [ROLES.AUDITOR],
    });
    ana.joinProject('proj-1', [ROLES.PROJECT_OWNER]);
    await principals.save(ana);
  });

  it('emite token com papeis e memberships nas claims', async () => {
    const result = await useCase.execute(
      { email: 'ana@banco.com', password: 'senha-correta' },
      TTL,
    );

    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(TTL);
    expect(signer.lastClaims()).toMatchObject({
      sub: 'user-ana',
      principal_type: 'user',
      email: 'ana@banco.com',
      roles: [ROLES.AUDITOR],
      memberships: [{ project_id: 'proj-1', roles: [ROLES.PROJECT_OWNER] }],
    });
  });

  it('normaliza o email: maiusculas e espacos nao impedem o login', async () => {
    await expect(
      useCase.execute({ email: '  ANA@Banco.com ', password: 'senha-correta' }, TTL),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('recusa senha errada', async () => {
    await expect(
      useCase.execute({ email: 'ana@banco.com', password: 'errada' }, TTL),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('da a mesma resposta para usuario inexistente, sem enumerar contas', async () => {
    const inexistente = await useCase
      .execute({ email: 'ninguem@banco.com', password: 'qualquer' }, TTL)
      .catch((error: unknown) => error);
    const senhaErrada = await useCase
      .execute({ email: 'ana@banco.com', password: 'errada' }, TTL)
      .catch((error: unknown) => error);

    expect(inexistente).toBeInstanceOf(InvalidCredentialsError);
    expect((inexistente as Error).message).toBe((senhaErrada as Error).message);
  });

  it('recusa principal desativado mesmo com a senha certa', async () => {
    const ana = await principals.findByEmail(Email.of('ana@banco.com'));
    ana?.disable();

    await expect(
      useCase.execute({ email: 'ana@banco.com', password: 'senha-correta' }, TTL),
    ).rejects.toBeInstanceOf(PrincipalDisabledError);
  });

  it('limita os escopos aos pedidos', async () => {
    const result = await useCase.execute(
      { email: 'ana@banco.com', password: 'senha-correta', requestedScopes: ['inference:read'] },
      TTL,
    );
    expect(result.scope).toBe('inference:read');
  });

  it('recusa escopo desconhecido em vez de ignora-lo', async () => {
    await expect(
      useCase.execute(
        { email: 'ana@banco.com', password: 'senha-correta', requestedScopes: ['tudo:*'] },
        TTL,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('recusa email mal formado antes de tocar o repositorio', async () => {
    await expect(
      useCase.execute({ email: 'nao-e-email', password: 'x' }, TTL),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

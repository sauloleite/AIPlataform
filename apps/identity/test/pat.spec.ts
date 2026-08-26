import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '@aia/errors';
import { CreatePat } from '../src/modules/auth/application/use-cases/create-pat.js';
import { IntrospectToken } from '../src/modules/auth/application/use-cases/introspect-token.js';
import { PrincipalEntity } from '../src/modules/auth/domain/entities/principal.js';
import { Email } from '../src/modules/auth/domain/value-objects/email.js';
import { PAT_PREFIX } from '../src/modules/auth/domain/entities/personal-access-token.js';
import { createHash } from 'node:crypto';
import {
  FakeIntrospectionCache,
  FakePatRepository,
  FakePrincipalRepository,
  FakeTokenHasher,
  FixedClock,
  SequentialIdGenerator,
} from './fakes/index.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const hashOf = (token: string): string =>
  createHash('sha256').update(`fake-pepper:${token}`).digest('hex');

describe('ciclo de vida do PAT', () => {
  let pats: FakePatRepository;
  let principals: FakePrincipalRepository;
  let cache: FakeIntrospectionCache;
  let clock: FixedClock;
  let createPat: CreatePat;
  let introspect: IntrospectToken;

  beforeEach(async () => {
    pats = new FakePatRepository();
    principals = new FakePrincipalRepository();
    cache = new FakeIntrospectionCache();
    clock = new FixedClock(NOW);
    const hasher = new FakeTokenHasher();

    createPat = new CreatePat(pats, principals, hasher, new SequentialIdGenerator(), clock);
    introspect = new IntrospectToken(pats, hasher, cache, clock);

    await principals.save(
      PrincipalEntity.createUser({
        id: 'user-ana',
        email: Email.of('ana@banco.com'),
        displayName: 'Ana',
        passwordHash: 'hashed:x',
      }),
    );
  });

  const issue = (overrides: Partial<Parameters<CreatePat['execute']>[0]> = {}) =>
    createPat.execute({
      principalId: 'user-ana',
      name: 'ci-pipeline',
      projectId: 'proj-1',
      scopes: ['inference:write'],
      expiresInDays: 30,
      ...overrides,
    });

  it('devolve o valor em claro apenas na criacao e persiste so o hash', async () => {
    const created = await issue();

    expect(created.token.startsWith(PAT_PREFIX)).toBe(true);
    const stored = pats.saved[0];
    expect(stored?.tokenHash).toBe(hashOf(created.token));
    // O que e persistido nao permite reconstruir o token.
    expect(JSON.stringify(stored?.toSnapshot())).not.toContain(created.token);
  });

  it('introspeccao devolve principal, escopo e projeto do token valido', async () => {
    const created = await issue();
    const result = await introspect.execute({ token: created.token });

    expect(result).toMatchObject({
      active: true,
      sub: 'user-ana',
      scope: 'inference:write',
      projectId: 'proj-1',
      principalType: 'application',
    });
  });

  it('a segunda introspeccao vem do cache, sem novo acesso ao repositorio', async () => {
    const created = await issue();
    await introspect.execute({ token: created.token });
    await introspect.execute({ token: created.token });

    expect(cache.hits).toBe(1);
  });

  it('token que nao tem o prefixo de PAT nao vira consulta ao banco', async () => {
    expect(await introspect.execute({ token: 'eyJhbGciOi.jwt.aqui' })).toEqual({ active: false });
  });

  it('token desconhecido e inativo', async () => {
    expect(await introspect.execute({ token: `${PAT_PREFIX}inexistente` })).toEqual({
      active: false,
    });
  });

  it('token expirado fica inativo assim que o prazo passa', async () => {
    const created = await issue({ expiresInDays: 1 });
    clock.advance(DAY + 1000);

    expect(await introspect.execute({ token: created.token })).toEqual({ active: false });
  });

  it('revogacao vale imediatamente, sem esperar o TTL do cache', async () => {
    const created = await issue();
    await introspect.execute({ token: created.token });

    const stored = await pats.findByHash(hashOf(created.token));
    stored?.revoke(clock.now());
    if (stored !== null) await pats.save(stored);
    await cache.invalidate(hashOf(created.token));

    expect(await introspect.execute({ token: created.token })).toEqual({ active: false });
  });

  it('recusa validade fora da faixa permitida', async () => {
    await expect(issue({ expiresInDays: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(issue({ expiresInDays: 400 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('recusa PAT sem escopo', async () => {
    await expect(issue({ scopes: [] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('recusa PAT para principal inexistente', async () => {
    await expect(issue({ principalId: 'nao-existe' })).rejects.toBeInstanceOf(NotFoundError);
  });
});

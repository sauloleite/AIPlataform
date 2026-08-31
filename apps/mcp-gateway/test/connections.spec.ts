import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';

import { Connection } from '../src/modules/tools/domain/entities/connection.js';
import {
  EnvSecretResolver,
  FileSecretResolver,
  FirstOf,
  envNameFor,
} from '../src/modules/tools/infrastructure/secrets/secret-resolvers.js';

/**
 * Connections: a credential the platform PRESENTS but never HOLDS.
 *
 * The tests worth having here are about what must NOT happen — a secret in the
 * database, a reference that reads a file it should not, a credential in a
 * header nobody chose.
 */

const NOW = new Date('2026-08-29T12:00:00Z');

function aConnection(overrides: Partial<Parameters<typeof Connection.create>[0]> = {}): Connection {
  return Connection.create({
    id: 'c1',
    projectId: 'p1',
    slug: 'gitlab',
    name: 'GitLab',
    kind: 'bearer',
    secretRef: 'gitlab-token',
    now: NOW,
    ...overrides,
  });
}

describe('what a connection is allowed to be', () => {
  it('holds a reference, and has nowhere to put a value', () => {
    const snapshot = aConnection().snapshot;

    expect(snapshot.secretRef).toBe('gitlab-token');
    // The shape itself is the guarantee: a dump of this collection hands over
    // endpoint names and nothing that opens them.
    expect(Object.keys(snapshot)).not.toContain('secret');
    expect(Object.keys(snapshot)).not.toContain('value');
  });

  it.each([
    ['a path separator', '../../etc/passwd'],
    ['a bare traversal', '..'],
    ['a leading slash', '/etc/passwd'],
    ['a nested path', 'sub/dir/token'],
    ['a space', 'token .pem'],
    ['an empty name', ''],
  ])('refuses a secret reference with %s', (_case, secretRef) => {
    // The file resolver reads `<dir>/<ref>`. A ref that escapes the directory
    // reads whatever the process can, and the signing key is in the same
    // container.
    expect(() => aConnection({ secretRef })).toThrow(ValidationError);
  });

  it('refuses a header name that could split the request', () => {
    const injected = 'X-Key' + String.fromCharCode(13, 10) + 'X-Admin: true';

    expect(() => aConnection({ kind: 'api_key', header: injected })).toThrow(ValidationError);
  });

  it('refuses a slug that is not a slug', () => {
    expect(() => aConnection({ slug: 'Not A Slug' })).toThrow(ValidationError);
  });

  it('allows no secret at all when the endpoint needs none', () => {
    const open = aConnection({ kind: 'none', secretRef: '' });

    expect(open.needsSecret).toBe(false);
    expect(open.credentialWith('anything')).toBeNull();
  });
});

describe('the header a connection produces', () => {
  it('presents a bearer token as Authorization', () => {
    expect(aConnection().credentialWith('sk-123')).toEqual({
      header: 'Authorization',
      value: 'Bearer sk-123',
    });
  });

  it('puts an api key in the header the operator chose', () => {
    const connection = aConnection({ kind: 'api_key', header: 'X-Api-Key' });

    expect(connection.credentialWith('sk-123')).toEqual({
      header: 'X-Api-Key',
      value: 'sk-123',
    });
  });

  it('encodes basic credentials', () => {
    const connection = aConnection({ kind: 'basic' });

    expect(connection.credentialWith('ana:hunter2')).toEqual({
      header: 'Authorization',
      value: `Basic ${btoa('ana:hunter2')}`,
    });
  });

  it('ignores a header choice for a bearer, because there is only one place', () => {
    const connection = aConnection({ kind: 'bearer', header: 'X-Somewhere-Else' });

    expect(connection.credentialWith('sk-123')?.header).toBe('Authorization');
  });
});

describe('FileSecretResolver', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aia-secrets-'));
    writeFileSync(join(directory, 'gitlab-token'), 'sk-from-a-file\n');
  });

  it('reads the named file and trims the trailing newline', async () => {
    // `echo secret > file` is how everyone writes one, and a newline in a
    // header is not part of the credential.
    const resolver = new FileSecretResolver(directory);

    expect(await resolver.resolve('gitlab-token')).toBe('sk-from-a-file');
  });

  it('answers null for a name nobody mounted', async () => {
    const resolver = new FileSecretResolver(directory);

    expect(await resolver.resolve('never-created')).toBeNull();
  });

  it.each(['../../../etc/passwd', 'sub/token', '/etc/passwd', '..'])(
    'refuses to read through %s',
    async (secretRef) => {
      // The last check before the syscall. The entity forbids these too; a
      // resolver that trusts its caller is one refactor away from reading
      // anything the process can.
      const resolver = new FileSecretResolver(directory);

      expect(await resolver.resolve(secretRef)).toBeNull();
    },
  );

  it('answers null when no directory is configured', async () => {
    expect(await new FileSecretResolver('').resolve('gitlab-token')).toBeNull();
  });

  it('does not walk into a subdirectory that happens to exist', async () => {
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'token'), 'nested-secret');
    const resolver = new FileSecretResolver(directory);

    expect(await resolver.resolve('nested/token')).toBeNull();
  });
});

describe('EnvSecretResolver', () => {
  it('reads AIA_SECRET_<REF>, uppercased', () => {
    expect(envNameFor('gitlab-token')).toBe('AIA_SECRET_GITLAB_TOKEN');
    expect(envNameFor('acme.api.key')).toBe('AIA_SECRET_ACME_API_KEY');
  });

  it('resolves from the environment it was given', async () => {
    const resolver = new EnvSecretResolver({ AIA_SECRET_GITLAB_TOKEN: 'sk-from-env' });

    expect(await resolver.resolve('gitlab-token')).toBe('sk-from-env');
  });

  it('treats an empty variable as absent, not as an empty credential', async () => {
    // An empty Authorization header is a 401 the operator then has to trace.
    const resolver = new EnvSecretResolver({ AIA_SECRET_GITLAB_TOKEN: '' });

    expect(await resolver.resolve('gitlab-token')).toBeNull();
  });

  it('refuses a reference that is not a name here too', async () => {
    const resolver = new EnvSecretResolver({ AIA_SECRET_X: 'v' });

    expect(await resolver.resolve('../x')).toBeNull();
  });
});

describe('FirstOf', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aia-secrets-'));
    writeFileSync(join(directory, 'shared'), 'from-the-file');
  });

  it('prefers the file over the environment', async () => {
    // ADR-015 orders them this way on purpose: a deployment that mounts a real
    // secret must never be shadowed by a leftover variable.
    const resolver = new FirstOf([
      new FileSecretResolver(directory),
      new EnvSecretResolver({ AIA_SECRET_SHARED: 'from-the-env' }),
    ]);

    expect(await resolver.resolve('shared')).toBe('from-the-file');
  });

  it('falls back to the environment when no file was mounted', async () => {
    const resolver = new FirstOf([
      new FileSecretResolver(directory),
      new EnvSecretResolver({ AIA_SECRET_ONLY_IN_ENV: 'from-the-env' }),
    ]);

    expect(await resolver.resolve('only-in-env')).toBe('from-the-env');
  });

  it('answers null when nothing has it', async () => {
    const resolver = new FirstOf([new FileSecretResolver(directory), new EnvSecretResolver({})]);

    expect(await resolver.resolve('nowhere')).toBeNull();
  });
});

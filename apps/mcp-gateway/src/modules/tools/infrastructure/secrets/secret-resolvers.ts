import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';

import type { SecretResolver } from '../../application/ports.js';
import { SECRET_REF_PATTERN } from '../../domain/entities/connection.js';

/**
 * Where a secret comes from, per ADR-015's three levels.
 *
 * `FileSecretResolver` covers self-hosted compose (`/run/secrets`) and
 * Kubernetes (a Secret mounted as files). `EnvSecretResolver` covers
 * development. `FirstOf` puts the file first, so a deployment that mounts a
 * real secret is never shadowed by a leftover environment variable.
 */

/**
 * Reads `<dir>/<ref>`.
 *
 * The reference is validated AGAIN here, not only on the entity. A resolver
 * that trusts its input is one config change away from reading the signing key
 * out of the same container, and this is the last place before the syscall.
 */
@Injectable()
export class FileSecretResolver implements SecretResolver {
  private readonly logger = new Logger(FileSecretResolver.name);

  constructor(private readonly directory: string) {}

  async resolve(secretRef: string): Promise<string | null> {
    if (this.directory === '' || !SECRET_REF_PATTERN.test(secretRef)) return null;

    const root = this.directory.endsWith(sep) ? this.directory : this.directory + sep;
    const path = join(this.directory, secretRef);
    // Belt and braces: the pattern already forbids a separator, so a path that
    // escapes the directory means the pattern was changed and this is what
    // notices.
    if (!normalize(path).startsWith(root)) {
      this.logger.warn(`refused a secret reference that escapes the directory: ${secretRef}`);
      return null;
    }

    try {
      // Trailing newline trimmed: `echo secret > file` is how everyone writes
      // one, and a newline in a header is not part of the credential.
      return (await readFile(path, 'utf8')).trim();
    } catch {
      return null;
    }
  }
}

/**
 * Reads `AIA_SECRET_<REF>`, uppercased with dots and dashes as underscores.
 *
 * Development in spirit, though nothing stops it elsewhere: an environment
 * variable leaks through `docker inspect` and a crash log, which is exactly why
 * ADR-015 puts files ahead of it.
 */
@Injectable()
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  async resolve(secretRef: string): Promise<string | null> {
    if (!SECRET_REF_PATTERN.test(secretRef)) return null;
    const value = this.source[envNameFor(secretRef)];
    return value === undefined || value === '' ? null : value;
  }
}

export function envNameFor(secretRef: string): string {
  return `AIA_SECRET_${secretRef.toUpperCase().replaceAll(/[.-]/g, '_')}`;
}

/** Tries each resolver in order and takes the first that answers. */
@Injectable()
export class FirstOf implements SecretResolver {
  constructor(private readonly resolvers: SecretResolver[]) {}

  async resolve(secretRef: string): Promise<string | null> {
    for (const resolver of this.resolvers) {
      const secret = await resolver.resolve(secretRef);
      if (secret !== null) return secret;
    }
    return null;
  }
}

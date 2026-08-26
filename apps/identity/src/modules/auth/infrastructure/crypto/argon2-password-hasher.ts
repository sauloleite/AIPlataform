import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import type { PasswordHasher } from '../../application/ports.js';

/**
 * Argon2id com os parametros recomendados pela OWASP.
 *
 * Lento de proposito: e o que torna forca bruta cara contra uma senha humana.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private static readonly OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
  } as const;

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, Argon2PasswordHasher.OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // Hash malformado (inclusive o descartavel usado contra timing attack)
      // significa "nao confere", nao "erro do servidor".
      return false;
    }
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TokenHasher } from '../../application/ports.js';

/**
 * HMAC-SHA256 com pepper do servidor.
 *
 * Deterministico, para permitir busca indexada, e com pepper para que um vazamento
 * do banco nao entregue tokens utilizaveis: sem a chave, o hash nao pode ser
 * reproduzido a partir de um token adivinhado.
 */
@Injectable()
export class HmacTokenHasher implements TokenHasher {
  constructor(private readonly pepper: string) {}

  hash(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('hex');
  }

  /** Comparacao em tempo constante, para quando o hash chega de fora. */
  matches(hash: string, token: string): boolean {
    const expected = Buffer.from(this.hash(token), 'hex');
    const actual = Buffer.from(hash, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

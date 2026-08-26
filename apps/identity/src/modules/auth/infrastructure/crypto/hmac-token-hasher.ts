import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TokenHasher } from '../../application/ports.js';

/**
 * HMAC-SHA256 with a server pepper.
 *
 * Deterministic so an indexed lookup is possible, and peppered so a database
 * leak does not hand over usable tokens: without the key, the hash cannot be
 * reproduced from a guessed token.
 */
@Injectable()
export class HmacTokenHasher implements TokenHasher {
  constructor(private readonly pepper: string) {}

  hash(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('hex');
  }

  /** Constant-time comparison, for when the hash arrives from outside. */
  matches(hash: string, token: string): boolean {
    const expected = Buffer.from(this.hash(token), 'hex');
    const actual = Buffer.from(hash, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

import { Injectable } from '@nestjs/common';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type JWK,
  type KeyLike,
} from 'jose';
import { NoSigningKeyError } from '../../domain/errors/index.js';
import type { SignedToken, TokenSigner } from '../../application/ports.js';

export interface SigningKeyMaterial {
  kid: string;
  privateKeyPem?: string;
  publicKeyPem?: string;
}

export interface JoseSignerOptions {
  issuer: string;
  audience: string;
  /** Keys already known at construction time, coming from configuration. */
  keys?: SigningKeyMaterial[];
  /**
   * Lazy loader, used when no key comes from configuration.
   *
   * It exists so the service persists the key it generated instead of minting a
   * new one on each restart: an ephemeral key invalidates every issued token and
   * leaves the other services holding a stale JWKS in cache.
   */
  loadKeys?: () => Promise<SigningKeyMaterial[]>;
}

const ALG = 'RS256';

/**
 * RS256 JWT issuer with its own JWKS.
 *
 * The private key signs; the public key is published at
 * `/.well-known/jwks.json`, and that is how every service validates tokens
 * locally without calling this one (ADR-004).
 *
 * Retired keys stay in the JWKS after rotation, so tokens already issued are not
 * invalidated all at once.
 */
@Injectable()
export class JoseTokenSigner implements TokenSigner {
  private activeKid?: string;
  private privateKey?: KeyLike;
  private readonly publicKeys = new Map<string, JWK>();
  private ready?: Promise<void>;

  constructor(private readonly options: JoseSignerOptions) {}

  private async initialize(): Promise<void> {
    let configured = this.options.keys ?? [];

    if (configured.length === 0 && this.options.loadKeys !== undefined) {
      configured = await this.options.loadKeys();
    }

    if (configured.length === 0) {
      // Last resort: an ephemeral in-memory pair. This only happens when there
      // is neither a configured key NOR a persistent store, e.g. in a unit test.
      const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
      const kid = 'ephemeral-1';
      this.privateKey = privateKey;
      this.activeKid = kid;
      this.publicKeys.set(kid, { ...(await exportJWK(publicKey)), kid, alg: ALG, use: 'sig' });
      return;
    }

    for (const key of configured) {
      if (key.publicKeyPem !== undefined) {
        const publicKey = await importSPKI(key.publicKeyPem, ALG, { extractable: true });
        this.publicKeys.set(key.kid, {
          ...(await exportJWK(publicKey)),
          kid: key.kid,
          alg: ALG,
          use: 'sig',
        });
      }
      // The first key with a private half is active; the rest only validate old tokens.
      if (key.privateKeyPem !== undefined && this.privateKey === undefined) {
        this.privateKey = await importPKCS8(key.privateKeyPem, ALG);
        this.activeKid = key.kid;
      }
    }
  }

  private async ensureReady(): Promise<void> {
    this.ready ??= this.initialize();
    await this.ready;
  }

  async sign(claims: Record<string, unknown>, ttlSeconds: number): Promise<SignedToken> {
    await this.ensureReady();
    if (this.privateKey === undefined || this.activeKid === undefined) {
      throw new NoSigningKeyError();
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: ALG, kid: this.activeKid })
      .setIssuedAt()
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setJti(crypto.randomUUID())
      .sign(this.privateKey);

    return { token, expiresAt };
  }

  async publicJwks(): Promise<{ keys: JWK[] }> {
    await this.ensureReady();
    return { keys: [...this.publicKeys.values()] };
  }
}

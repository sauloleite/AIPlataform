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
  /** Chaves ja conhecidas na construcao (vindas da configuracao). */
  keys?: SigningKeyMaterial[];
  /**
   * Carregador tardio, usado quando a chave nao vem da configuracao.
   *
   * Existe para que o servico persista a chave que gerou, em vez de criar uma
   * nova a cada restart: chave efemera invalida todo token ja emitido e ainda
   * deixa os outros servicos com um JWKS obsoleto em cache.
   */
  loadKeys?: () => Promise<SigningKeyMaterial[]>;
}

const ALG = 'RS256';

/**
 * Emissor de JWT RS256 com JWKS proprio.
 *
 * Chave privada assina; chave publica vai para o `/.well-known/jwks.json`, e e
 * assim que todo servico valida token localmente sem chamar este aqui (ADR-004).
 *
 * Chaves antigas continuam no JWKS depois da rotacao, para que tokens ja emitidos
 * nao sejam invalidados de uma vez.
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
      // Ultimo recurso: par efemero em memoria. So acontece quando nao ha chave
      // configurada NEM store persistente (por exemplo, em teste unitario).
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
      // A primeira chave com privada e a ativa; as demais so validam tokens antigos.
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

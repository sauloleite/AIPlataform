import { Injectable, Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import type { SigningKeyMaterial } from '../crypto/jose-token-signer.js';

interface SigningKeyDocument {
  _id: string;
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: Date;
  retiredAt?: Date;
}

const ALG = 'RS256';

/**
 * Persisted signing key.
 *
 * This exists because of a concrete problem: a key generated in memory changes
 * on every process restart, and every token issued before it becomes invalid —
 * made worse by the other services still holding the old JWKS in cache and
 * returning 401 for no apparent reason.
 *
 * By persisting the key, development behaves like production without anyone
 * having to generate and commit a secret. In production the key still comes from
 * configuration (Vault, Infisical, a Kubernetes Secret) and this store is never
 * consulted.
 */
@Injectable()
export class MongoSigningKeyStore {
  private readonly logger = new Logger(MongoSigningKeyStore.name);
  private readonly collection: Collection<SigningKeyDocument>;

  constructor(db: Db) {
    this.collection = db.collection<SigningKeyDocument>('signing_keys');
  }

  /**
   * Keys available for signing and validation.
   *
   * The first one is active. Retired keys stay in the JWKS so tokens already
   * issued remain valid until they expire.
   */
  async loadOrCreate(kid: string): Promise<SigningKeyMaterial[]> {
    const existing = await this.collection.find({}).sort({ createdAt: -1 }).toArray();
    const active = existing.find((key) => key.retiredAt === undefined);

    if (active !== undefined) {
      const retired = existing.filter((key) => key.retiredAt !== undefined);
      return [
        { kid: active._id, privateKeyPem: active.privateKeyPem, publicKeyPem: active.publicKeyPem },
        ...retired.map((key) => ({ kid: key._id, publicKeyPem: key.publicKeyPem })),
      ];
    }

    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    const document: SigningKeyDocument = {
      _id: kid,
      privateKeyPem: await exportPKCS8(privateKey),
      publicKeyPem: await exportSPKI(publicKey),
      createdAt: new Date(),
    };

    // Insert without upsert: if two replicas start together, one loses the race
    // and reloads the other's key instead of overwriting it.
    try {
      await this.collection.insertOne(document);
      this.logger.log(`signing key ${kid} generated and persisted`);
    } catch {
      this.logger.log('another replica generated the key first; reloading');
      return this.loadOrCreate(kid);
    }

    return [{ kid, privateKeyPem: document.privateKeyPem, publicKeyPem: document.publicKeyPem }];
  }

  /** Retires the active key and generates another. The old one stays in the JWKS. */
  async rotate(newKid: string): Promise<SigningKeyMaterial[]> {
    await this.collection.updateMany(
      { retiredAt: { $exists: false } },
      { $set: { retiredAt: new Date() } },
    );
    return this.loadOrCreate(newKid);
  }
}

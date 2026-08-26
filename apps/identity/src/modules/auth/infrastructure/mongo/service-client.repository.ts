import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import { ServiceClient } from '../../domain/entities/service-client.js';
import { TokenScopes } from '../../domain/value-objects/token-scopes.js';
import type { ServiceClientRepository, TokenHasher } from '../../application/ports.js';

interface ServiceClientDocument {
  _id: string;
  displayName: string;
  secretHash: string;
  scopes: string[];
  enabled: boolean;
  createdAt: Date;
}

@Injectable()
export class MongoServiceClientRepository implements ServiceClientRepository {
  private readonly collection: Collection<ServiceClientDocument>;

  constructor(
    db: Db,
    private readonly hasher: TokenHasher,
  ) {
    this.collection = db.collection<ServiceClientDocument>('service_clients');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ enabled: 1 });
  }

  async findByClientId(clientId: string): Promise<ServiceClient | null> {
    const document = await this.collection.findOne({ _id: clientId });
    if (document === null) return null;

    return ServiceClient.rehydrate({
      clientId: document._id,
      displayName: document.displayName,
      secretHash: document.secretHash,
      scopes: TokenScopes.of(document.scopes),
      enabled: document.enabled,
      createdAt: document.createdAt,
    });
  }

  async save(client: ServiceClient): Promise<void> {
    const snapshot = client.toSnapshot();
    await this.collection.updateOne(
      { _id: snapshot.clientId },
      {
        $set: {
          displayName: snapshot.displayName,
          secretHash: snapshot.secretHash,
          scopes: snapshot.scopes.toArray(),
          enabled: snapshot.enabled,
          createdAt: snapshot.createdAt,
        },
      },
      { upsert: true },
    );
  }

  matches(client: ServiceClient, presentedSecret: string): boolean {
    const expected = Buffer.from(client.secretHash, 'hex');
    const actual = Buffer.from(this.hasher.hash(presentedSecret), 'hex');
    // Comprimentos iguais sempre (mesmo algoritmo), mas a checagem evita que
    // timingSafeEqual lance em caso de hash corrompido no banco.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

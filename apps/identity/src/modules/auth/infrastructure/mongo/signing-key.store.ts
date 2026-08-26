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
 * Chave de assinatura persistida.
 *
 * Existe por causa de um problema concreto: uma chave gerada em memoria muda a
 * cada restart do processo, e todo token emitido antes vira invalido — com o
 * agravante de que os outros servicos ainda tem o JWKS antigo em cache e passam
 * a devolver 401 sem motivo aparente.
 *
 * Persistindo a chave, o ambiente de desenvolvimento se comporta como producao
 * sem exigir que ninguem gere e commite um segredo. Em producao a chave continua
 * vindo da configuracao (Vault, Infisical, Secret do Kubernetes), e este store
 * nem e consultado.
 */
@Injectable()
export class MongoSigningKeyStore {
  private readonly logger = new Logger(MongoSigningKeyStore.name);
  private readonly collection: Collection<SigningKeyDocument>;

  constructor(db: Db) {
    this.collection = db.collection<SigningKeyDocument>('signing_keys');
  }

  /**
   * Chaves disponiveis para assinar e validar.
   *
   * A primeira e a ativa. As aposentadas continuam no JWKS para que tokens ja
   * emitidos sigam validos ate expirarem.
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

    // `upsert: false` com insert: se duas replicas subirem juntas, uma perde a
    // corrida e recarrega a chave da outra, em vez de sobrescrever.
    try {
      await this.collection.insertOne(document);
      this.logger.log(`chave de assinatura ${kid} gerada e persistida`);
    } catch {
      this.logger.log('outra replica gerou a chave primeiro; recarregando');
      return this.loadOrCreate(kid);
    }

    return [{ kid, privateKeyPem: document.privateKeyPem, publicKeyPem: document.publicKeyPem }];
  }

  /** Aposenta a chave ativa e gera outra. A antiga fica no JWKS. */
  async rotate(newKid: string): Promise<SigningKeyMaterial[]> {
    await this.collection.updateMany(
      { retiredAt: { $exists: false } },
      { $set: { retiredAt: new Date() } },
    );
    return this.loadOrCreate(newKid);
  }
}

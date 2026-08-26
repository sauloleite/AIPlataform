import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import type { Role } from '@aia/auth';
import { PrincipalEntity, type PrincipalProps } from '../../domain/entities/principal.js';
import { Email } from '../../domain/value-objects/email.js';
import type { PrincipalRepository } from '../../application/ports.js';

interface PrincipalDocument {
  _id: string;
  type: 'user' | 'application' | 'service';
  email?: string;
  displayName?: string;
  passwordHash?: string;
  globalRoles: Role[];
  memberships: { projectId: string; roles: Role[] }[];
  enabled: boolean;
  createdAt: Date;
}

function toEntity(document: PrincipalDocument): PrincipalEntity {
  const props: PrincipalProps = {
    id: document._id,
    type: document.type,
    ...(document.email !== undefined && { email: Email.of(document.email) }),
    ...(document.displayName !== undefined && { displayName: document.displayName }),
    ...(document.passwordHash !== undefined && { passwordHash: document.passwordHash }),
    globalRoles: document.globalRoles,
    memberships: document.memberships,
    enabled: document.enabled,
    createdAt: document.createdAt,
  };
  return PrincipalEntity.rehydrate(props);
}

function toDocument(principal: PrincipalEntity): PrincipalDocument {
  const snapshot = principal.toSnapshot();
  return {
    _id: snapshot.id,
    type: snapshot.type,
    ...(snapshot.email !== undefined && { email: snapshot.email.value }),
    ...(snapshot.displayName !== undefined && { displayName: snapshot.displayName }),
    ...(snapshot.passwordHash !== undefined && { passwordHash: snapshot.passwordHash }),
    globalRoles: snapshot.globalRoles,
    memberships: snapshot.memberships,
    enabled: snapshot.enabled,
    createdAt: snapshot.createdAt,
  };
}

@Injectable()
export class MongoPrincipalRepository implements PrincipalRepository {
  private readonly collection: Collection<PrincipalDocument>;

  constructor(db: Db) {
    this.collection = db.collection<PrincipalDocument>('principals');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { email: 1 },
      { unique: true, partialFilterExpression: { email: { $exists: true } } },
    );
    await this.collection.createIndex({ 'memberships.projectId': 1 });
  }

  async findById(id: string): Promise<PrincipalEntity | null> {
    const document = await this.collection.findOne({ _id: id });
    return document === null ? null : toEntity(document);
  }

  async findByEmail(email: Email): Promise<PrincipalEntity | null> {
    const document = await this.collection.findOne({ email: email.value });
    return document === null ? null : toEntity(document);
  }

  async save(principal: PrincipalEntity): Promise<void> {
    const document = toDocument(principal);
    const { _id, ...rest } = document;
    await this.collection.updateOne({ _id }, { $set: rest }, { upsert: true });
  }
}

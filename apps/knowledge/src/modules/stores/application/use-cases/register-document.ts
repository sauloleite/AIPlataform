import { Inject, Injectable } from '@nestjs/common';
import { Document } from '../../domain/entities/document.js';
import { StoreNotFoundError } from '../../domain/errors/index.js';
import { DocumentAcl } from '../../domain/value-objects/document-acl.js';
import type { RegisterDocumentCommand, UploadTicketView } from '../dto.js';
import {
  STORE_REPOSITORY,
  DOCUMENT_REPOSITORY,
  OBJECT_STORE,
  KNOWLEDGE_BUCKET,
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type DocumentRepository,
  type IdGenerator,
  type ObjectStore,
  type VectorStoreRepository,
} from '../ports.js';
import { documentView } from '../views.js';

const UPLOAD_TTL_SECONDS = 900;

/**
 * Registers a document and hands back a presigned URL.
 *
 * Deliberately does NOT queue ingestion. Flow 7.3 queues before the client has
 * finished uploading, which means the worker can start on an object that is
 * not there yet; `CompleteDocumentUpload` confirms the bytes exist first. One
 * extra round trip buys a race that cannot happen.
 */
@Injectable()
export class RegisterDocument {
  constructor(
    @Inject(STORE_REPOSITORY) private readonly stores: VectorStoreRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(KNOWLEDGE_BUCKET) private readonly bucket: string,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: RegisterDocumentCommand): Promise<UploadTicketView> {
    const store = await this.stores.findById(command.projectId, command.storeId);
    if (store === null) throw new StoreNotFoundError(command.storeId, command.projectId);

    const id = this.ids.next();
    // The project is in the key, so an object cannot be reached by guessing an
    // id from another tenant.
    const objectKey = `${command.projectId}/${store.id}/${id}`;

    const document = Document.register({
      id,
      projectId: command.projectId,
      storeId: store.id,
      title: command.title,
      objectKey,
      mimeType: command.mimeType,
      sizeBytes: command.sizeBytes,
      acl: DocumentAcl.of(command.acl),
      ownerPrincipalId: command.principalId,
      now: this.clock.now(),
    });

    const ticket = await this.objects.presignUpload({
      bucket: this.bucket,
      key: objectKey,
      expiresInSeconds: UPLOAD_TTL_SECONDS,
    });

    await this.documents.save(document);

    return {
      document: documentView(document),
      uploadUrl: ticket.url,
      expiresAt: ticket.expiresAt.toISOString(),
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { DocumentNotFoundError, InvalidStoreError } from '../../domain/errors/index.js';
import type { DocumentView } from '../dto.js';
import {
  DOCUMENT_REPOSITORY,
  OBJECT_STORE,
  INGESTION_QUEUE,
  KNOWLEDGE_BUCKET,
  CLOCK,
  type Clock,
  type DocumentRepository,
  type IngestionQueue,
  type ObjectStore,
} from '../ports.js';
import { documentView } from '../views.js';

/**
 * Confirms the bytes are in storage and queues ingestion.
 *
 * The queue key is the document id and its version, so a client that retries
 * this call does not enqueue the same work twice.
 */
@Injectable()
export class CompleteDocumentUpload {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(OBJECT_STORE) private readonly objects: ObjectStore,
    @Inject(INGESTION_QUEUE) private readonly queue: IngestionQueue,
    @Inject(KNOWLEDGE_BUCKET) private readonly bucket: string,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    documentId: string;
    accessToken: string;
  }): Promise<DocumentView> {
    const document = await this.documents.findById(input.projectId, input.documentId);
    if (document === null) throw new DocumentNotFoundError(input.documentId);

    const stat = await this.objects.stat({ bucket: this.bucket, key: document.objectKey });
    if (stat === null) {
      // A clean, typed refusal here beats a mysterious worker failure later.
      throw new InvalidStoreError('The document has not been uploaded yet');
    }

    // A second upload of new bytes reindexes: the version guards the vectors
    // the previous one wrote.
    if (document.isTerminal) document.startReingestion(this.clock.now());

    await this.documents.save(document);
    await this.queue.enqueue(
      {
        projectId: input.projectId,
        storeId: document.storeId,
        documentId: document.id,
        accessToken: input.accessToken,
      },
      // BullMQ forbids ':' in a custom job id -- it is its own key separator.
      `${document.id}-v${document.version.toString()}`,
    );

    return documentView(document);
  }
}

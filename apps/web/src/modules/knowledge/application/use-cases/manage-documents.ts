import type {
  CreateStoreInput,
  DocumentSummary,
  KnowledgeGateway,
  SearchHit,
  StoreSummary,
} from '../ports';

export class CreateStore {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(accessToken: string, projectId: string, input: CreateStoreInput): Promise<StoreSummary> {
    return this.knowledge.createStore(accessToken, projectId, input);
  }
}

/**
 * Uploads a document.
 *
 * The bytes go from the console's server straight to object storage on the
 * presigned URL, and only then is ingestion confirmed. Routing them through
 * the knowledge service would put every PDF through a second process for no
 * reason, and queuing before the bytes exist is the race flow 7.3 invites.
 */
export class UploadDocument {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  async execute(
    accessToken: string,
    projectId: string,
    storeId: string,
    file: { name: string; type: string; bytes: ArrayBuffer },
  ): Promise<DocumentSummary> {
    const { document, uploadUrl } = await this.knowledge.registerDocument(
      accessToken,
      projectId,
      storeId,
      { title: file.name, mimeType: file.type, sizeBytes: file.bytes.byteLength },
    );

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      body: file.bytes,
      headers: { 'Content-Type': file.type },
    });
    if (!upload.ok) {
      throw new Error(`the upload was rejected with ${upload.status.toString()}`);
    }

    return this.knowledge.completeUpload(accessToken, projectId, storeId, document.id);
  }
}

export class DeleteDocument {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(
    accessToken: string,
    projectId: string,
    storeId: string,
    documentId: string,
  ): Promise<void> {
    return this.knowledge.deleteDocument(accessToken, projectId, storeId, documentId);
  }
}

export class SearchStore {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(
    accessToken: string,
    projectId: string,
    storeId: string,
    query: string,
  ): Promise<SearchHit[]> {
    return this.knowledge.search(accessToken, projectId, storeId, { query, topK: 5 });
  }
}

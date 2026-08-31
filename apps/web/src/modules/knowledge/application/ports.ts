/** The console's view of aia-knowledge. One gateway per service. */

export type IngestionStatus =
  'pending' | 'parsing' | 'chunking' | 'embedding' | 'indexing' | 'ingested' | 'failed';

export type StoreVisibility = 'private' | 'public';
export type StoreAccess = 'owner' | 'shared';

export interface StoreSummary {
  id: string;
  /** The project that owns it -- not always the one looking at it. */
  ownerProjectId: string;
  visibility: StoreVisibility;
  /** Absent in the catalogue, where the project has not decided yet. */
  access?: StoreAccess;
  subscribed?: boolean;
  slug: string;
  name: string;
  description?: string;
  embeddingAlias: string;
  embeddingModel: string;
  dimensions: number;
  chunking: { kind: string; maxTokens: number; overlapTokens: number };
  documentCount: number;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  storeId: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  status: IngestionStatus;
  errorCode: string | null;
  chunkCount: number;
  createdAt: string;
  ingestedAt: string | null;
}

export interface SearchHit {
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  /** Cosine in vector mode, the fused score in hybrid. Not one scale. */
  score: number;
  retrieval: 'vector' | 'text' | 'both';
  /** The cosine, when the vector ranking reached it. */
  vectorScore?: number;
  text: string;
}

export interface CreateStoreInput {
  slug: string;
  name: string;
  description?: string;
  embeddingAlias: string;
  chunking: { kind?: string; maxTokens?: number; overlapTokens?: number };
}

export interface KnowledgeGateway {
  listStores(accessToken: string, projectId: string): Promise<StoreSummary[]>;
  getStore(accessToken: string, projectId: string, storeId: string): Promise<StoreSummary>;
  createStore(
    accessToken: string,
    projectId: string,
    input: CreateStoreInput,
  ): Promise<StoreSummary>;
  listDocuments(
    accessToken: string,
    projectId: string,
    storeId: string,
  ): Promise<DocumentSummary[]>;
  /** Registers the document and returns where the bytes should be PUT. */
  registerDocument(
    accessToken: string,
    projectId: string,
    storeId: string,
    input: { title: string; mimeType: string; sizeBytes: number },
  ): Promise<{ document: DocumentSummary; uploadUrl: string }>;
  completeUpload(
    accessToken: string,
    projectId: string,
    storeId: string,
    documentId: string,
  ): Promise<DocumentSummary>;
  deleteDocument(
    accessToken: string,
    projectId: string,
    storeId: string,
    documentId: string,
  ): Promise<void>;
  search(
    accessToken: string,
    projectId: string,
    storeId: string,
    input: { query: string; topK: number; mode?: 'vector' | 'hybrid' },
  ): Promise<SearchHit[]>;
  /** Stores other projects published and this one could reuse (ADR-023). */
  listCatalogue(accessToken: string, projectId: string): Promise<StoreSummary[]>;
  setVisibility(
    accessToken: string,
    projectId: string,
    storeId: string,
    visibility: StoreVisibility,
  ): Promise<StoreSummary>;
  subscribe(accessToken: string, projectId: string, storeId: string): Promise<StoreSummary>;
  unsubscribe(accessToken: string, projectId: string, storeId: string): Promise<void>;
}

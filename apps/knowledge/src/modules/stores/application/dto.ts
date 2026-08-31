import type { IngestionStatus } from '../domain/entities/document.js';

export interface CreateStoreCommand {
  projectId: string;
  slug: string;
  name: string;
  description?: string;
  embeddingAlias: string;
  accessToken: string;
  chunking: { kind?: string; maxTokens?: number; overlapTokens?: number };
}

export interface RegisterDocumentCommand {
  projectId: string;
  storeId: string;
  principalId: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  acl: { isPublic?: boolean; groups?: string[]; principals?: string[] };
}

export interface SearchCommand {
  projectId: string;
  storeId: string;
  principalId: string;
  principalGroups: readonly string[];
  accessToken: string;
  query: string;
  topK: number;
  /** Defaults to hybrid; `vector` is the escape hatch the contract documents. */
  mode?: 'vector' | 'hybrid';
  minScore?: number;
}

export interface StoreView {
  id: string;
  /** The project that OWNS it, which is not always the one reading. */
  projectId: string;
  visibility: 'private' | 'public';
  /** How the reading project reaches it: it owns it, or it subscribed. */
  access?: 'owner' | 'shared';
  /** Catalogue only: whether the reading project has already accepted it. */
  subscribed?: boolean;
  slug: string;
  name: string;
  description?: string;
  embeddingAlias: string;
  embeddingModel: string;
  dimensions: number;
  chunking: { kind: string; maxTokens: number; overlapTokens: number };
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentView {
  id: string;
  storeId: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string | null;
  version: number;
  status: IngestionStatus;
  errorCode: string | null;
  chunkCount: number;
  acl: { public: boolean; groups: string[]; principals: string[] };
  createdAt: string;
  ingestedAt: string | null;
}

export interface UploadTicketView {
  document: DocumentView;
  uploadUrl: string;
  expiresAt: string;
}

export interface SearchHitView {
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  /** Cosine in vector mode, the fused score in hybrid. Not one scale. */
  score: number;
  retrieval: 'vector' | 'text' | 'both';
  vectorScore?: number;
  text: string;
}

import { PlatformError, type ProblemDetails } from '../../../console/domain/errors';
import type {
  CreateStoreInput,
  DocumentSummary,
  IngestionStatus,
  KnowledgeGateway,
  SearchHit,
  StoreAccess,
  StoreSummary,
  StoreVisibility,
} from '../../application/ports';

/**
 * aia-knowledge over HTTP.
 *
 * Server-side only: it takes the access token as an argument, and a token that
 * reaches the browser is a token an XSS can read. The document bytes are the
 * one exception -- they go straight from the browser to object storage on a
 * presigned URL, which is what keeps a 50 MB PDF out of this process entirely.
 */
export class HttpKnowledgeGateway implements KnowledgeGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async listStores(accessToken: string, projectId: string): Promise<StoreSummary[]> {
    const body = await this.json<{ items: RawStore[] }>(`${this.baseUrl}/v1/stores`, {
      accessToken,
      projectId,
    });
    return body.items.map(toStore);
  }

  async getStore(accessToken: string, projectId: string, storeId: string): Promise<StoreSummary> {
    const raw = await this.json<RawStore>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}`,
      { accessToken, projectId },
    );
    return toStore(raw);
  }

  async createStore(
    accessToken: string,
    projectId: string,
    input: CreateStoreInput,
  ): Promise<StoreSummary> {
    const raw = await this.json<RawStore>(`${this.baseUrl}/v1/stores`, {
      method: 'POST',
      accessToken,
      projectId,
      body: {
        slug: input.slug,
        name: input.name,
        ...(input.description !== undefined && { description: input.description }),
        embedding_alias: input.embeddingAlias,
        chunking: {
          ...(input.chunking.kind !== undefined && { kind: input.chunking.kind }),
          ...(input.chunking.maxTokens !== undefined && { max_tokens: input.chunking.maxTokens }),
          ...(input.chunking.overlapTokens !== undefined && {
            overlap_tokens: input.chunking.overlapTokens,
          }),
        },
      },
    });
    return toStore(raw);
  }

  async listDocuments(
    accessToken: string,
    projectId: string,
    storeId: string,
  ): Promise<DocumentSummary[]> {
    const body = await this.json<{ items: RawDocument[] }>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/documents`,
      { accessToken, projectId },
    );
    return body.items.map(toDocument);
  }

  async registerDocument(
    accessToken: string,
    projectId: string,
    storeId: string,
    input: { title: string; mimeType: string; sizeBytes: number },
  ): Promise<{ document: DocumentSummary; uploadUrl: string }> {
    const body = await this.json<{ document: RawDocument; upload_url: string }>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/documents`,
      {
        method: 'POST',
        accessToken,
        projectId,
        body: { title: input.title, mime_type: input.mimeType, size_bytes: input.sizeBytes },
      },
    );
    return { document: toDocument(body.document), uploadUrl: body.upload_url };
  }

  async completeUpload(
    accessToken: string,
    projectId: string,
    storeId: string,
    documentId: string,
  ): Promise<DocumentSummary> {
    const raw = await this.json<RawDocument>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/documents/${encodeURIComponent(documentId)}/complete`,
      { method: 'POST', accessToken, projectId },
    );
    return toDocument(raw);
  }

  async deleteDocument(
    accessToken: string,
    projectId: string,
    storeId: string,
    documentId: string,
  ): Promise<void> {
    await this.json<undefined>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/documents/${encodeURIComponent(documentId)}`,
      { method: 'DELETE', accessToken, projectId },
    );
  }

  async search(
    accessToken: string,
    projectId: string,
    storeId: string,
    input: { query: string; topK: number; mode?: 'vector' | 'hybrid' },
  ): Promise<SearchHit[]> {
    const body = await this.json<{ results: RawHit[] }>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/search`,
      {
        method: 'POST',
        accessToken,
        projectId,
        body: {
          query: input.query,
          top_k: input.topK,
          ...(input.mode !== undefined && { mode: input.mode }),
        },
      },
    );
    return body.results.map((hit) => ({
      documentId: hit.document_id,
      documentTitle: hit.document_title,
      chunkIndex: hit.chunk_index,
      score: hit.score,
      retrieval: hit.retrieval ?? 'vector',
      ...(hit.vector_score !== undefined && { vectorScore: hit.vector_score }),
      text: hit.text,
    }));
  }

  async listCatalogue(accessToken: string, projectId: string): Promise<StoreSummary[]> {
    const body = await this.json<{ items: RawStore[] }>(`${this.baseUrl}/v1/stores/catalogue`, {
      accessToken,
      projectId,
    });
    return body.items.map(toStore);
  }

  async setVisibility(
    accessToken: string,
    projectId: string,
    storeId: string,
    visibility: StoreVisibility,
  ): Promise<StoreSummary> {
    const raw = await this.json<RawStore>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/visibility`,
      { method: 'PUT', accessToken, projectId, body: { visibility } },
    );
    return toStore(raw);
  }

  async subscribe(accessToken: string, projectId: string, storeId: string): Promise<StoreSummary> {
    const raw = await this.json<RawStore>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/subscription`,
      { method: 'PUT', accessToken, projectId },
    );
    return toStore(raw);
  }

  async unsubscribe(accessToken: string, projectId: string, storeId: string): Promise<void> {
    await this.json<unknown>(
      `${this.baseUrl}/v1/stores/${encodeURIComponent(storeId)}/subscription`,
      { method: 'DELETE', accessToken, projectId },
    );
  }

  private async json<T>(
    url: string,
    options: {
      method?: string;
      accessToken?: string;
      projectId?: string;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
          ...(options.accessToken !== undefined && {
            Authorization: `Bearer ${options.accessToken}`,
          }),
          ...(options.projectId !== undefined && { 'X-Project-Id': options.projectId }),
        },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok) throw await problemFrom(response);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RawStore {
  id: string;
  project_id: string;
  visibility?: StoreVisibility;
  access?: StoreAccess;
  subscribed?: boolean;
  slug: string;
  name: string;
  description?: string;
  embedding_alias: string;
  embedding_model: string;
  dimensions: number;
  chunking: { kind: string; max_tokens: number; overlap_tokens: number };
  document_count: number;
  updated_at?: string;
}

interface RawDocument {
  id: string;
  store_id: string;
  title: string;
  mime_type: string;
  size_bytes: number;
  status: IngestionStatus;
  error_code: string | null;
  chunk_count: number;
  created_at: string;
  ingested_at: string | null;
}

interface RawHit {
  document_id: string;
  document_title: string;
  chunk_index: number;
  score: number;
  retrieval?: 'vector' | 'text' | 'both';
  vector_score?: number;
  text: string;
}

function toStore(raw: RawStore): StoreSummary {
  return {
    id: raw.id,
    ownerProjectId: raw.project_id,
    // A store written before sharing existed reports nothing. Private is the
    // only safe reading of silence, here as in the repository.
    visibility: raw.visibility ?? 'private',
    ...(raw.access !== undefined && { access: raw.access }),
    ...(raw.subscribed !== undefined && { subscribed: raw.subscribed }),
    slug: raw.slug,
    name: raw.name,
    ...(raw.description !== undefined && { description: raw.description }),
    embeddingAlias: raw.embedding_alias,
    embeddingModel: raw.embedding_model,
    dimensions: raw.dimensions,
    chunking: {
      kind: raw.chunking.kind,
      maxTokens: raw.chunking.max_tokens,
      overlapTokens: raw.chunking.overlap_tokens,
    },
    documentCount: raw.document_count,
    updatedAt: raw.updated_at ?? '',
  };
}

function toDocument(raw: RawDocument): DocumentSummary {
  return {
    id: raw.id,
    storeId: raw.store_id,
    title: raw.title,
    mimeType: raw.mime_type,
    sizeBytes: raw.size_bytes,
    status: raw.status,
    errorCode: raw.error_code,
    chunkCount: raw.chunk_count,
    createdAt: raw.created_at,
    ingestedAt: raw.ingested_at,
  };
}

async function problemFrom(response: Response): Promise<PlatformError> {
  try {
    return new PlatformError((await response.json()) as ProblemDetails);
  } catch {
    return new PlatformError({
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: 'internal_error',
    });
  }
}

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@aia/errors';
import { parseRegisterDocument } from '../src/modules/stores/presentation/http/dto.js';

import {
  toDocumentResponse,
  toSearchHitResponse,
  toStoreResponse,
  toUploadTicketResponse,
} from '../src/modules/stores/presentation/http/mappers.js';
import type { DocumentView, StoreView } from '../src/modules/stores/application/dto.js';

/** The wire is snake_case because `contracts/openapi/knowledge.v1.yaml` says so. */

const STORE: StoreView = {
  id: 's1',
  projectId: 'p1',
  visibility: 'private',
  slug: 'handbook',
  name: 'Handbook',
  embeddingAlias: 'embedding-default',
  embeddingModel: 'nomic-embed-text',
  dimensions: 768,
  chunking: { kind: 'markdown-heading', maxTokens: 512, overlapTokens: 64 },
  documentCount: 4,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
};

const DOCUMENT: DocumentView = {
  id: 'd1',
  storeId: 's1',
  title: 'Handbook',
  mimeType: 'text/markdown',
  sizeBytes: 2048,
  contentHash: 'sha256:abc',
  version: 1,
  status: 'ingested',
  errorCode: null,
  chunkCount: 12,
  acl: { public: true, groups: [], principals: [] },
  createdAt: '2026-08-01T00:00:00Z',
  ingestedAt: '2026-08-01T00:01:00Z',
};

describe('toStoreResponse', () => {
  it('names every field the way the contract does', () => {
    expect(Object.keys(toStoreResponse(STORE)).sort()).toEqual([
      'chunking',
      'created_at',
      'dimensions',
      'document_count',
      'embedding_alias',
      'embedding_model',
      'id',
      'name',
      'project_id',
      'slug',
      'updated_at',
      'visibility',
    ]);
  });

  it('reports how the reading project reaches a shared store', () => {
    const response = toStoreResponse({ ...STORE, visibility: 'public', access: 'shared' });

    expect(response['visibility']).toBe('public');
    expect(response['access']).toBe('shared');
    // `subscribed` belongs to the catalogue, where the question is still open.
    expect(response).not.toHaveProperty('subscribed');
  });

  it('translates the nested chunking strategy too', () => {
    // A nested object is where a mapper is most likely to be half-done: the
    // outer keys look right and the inner ones silently read as undefined.
    expect(toStoreResponse(STORE)['chunking']).toEqual({
      kind: 'markdown-heading',
      max_tokens: 512,
      overlap_tokens: 64,
    });
  });

  it('pins the dimensions, because a store cannot change them', () => {
    expect(toStoreResponse(STORE)['dimensions']).toBe(768);
  });
});

describe('toDocumentResponse', () => {
  it('translates the ingestion fields', () => {
    const response = toDocumentResponse(DOCUMENT);

    expect(response['store_id']).toBe('s1');
    expect(response['mime_type']).toBe('text/markdown');
    expect(response['content_hash']).toBe('sha256:abc');
    expect(response['chunk_count']).toBe(12);
    expect(response['ingested_at']).toBe('2026-08-01T00:01:00Z');
  });

  it('keeps a failure code visible', () => {
    const response = toDocumentResponse({
      ...DOCUMENT,
      status: 'failed',
      errorCode: 'unsupported_media_type',
      ingestedAt: null,
    });

    expect(response['error_code']).toBe('unsupported_media_type');
    expect(response).toHaveProperty('ingested_at', null);
  });

  it('carries the ACL through, because it is what security trimming reads', () => {
    const response = toDocumentResponse({
      ...DOCUMENT,
      acl: { public: false, groups: ['g1'], principals: ['u1'] },
    });

    expect(response['acl']).toEqual({ public: false, groups: ['g1'], principals: ['u1'] });
  });
});

describe('toUploadTicketResponse', () => {
  it('nests the translated document under the presigned url', () => {
    const response = toUploadTicketResponse({
      document: DOCUMENT,
      uploadUrl: 'https://minio/put',
      expiresAt: '2026-08-01T00:05:00Z',
    });

    expect(response['upload_url']).toBe('https://minio/put');
    expect(response['expires_at']).toBe('2026-08-01T00:05:00Z');
    expect(response['document']).toHaveProperty('store_id', 's1');
  });
});

describe('toSearchHitResponse', () => {
  it('translates a citation', () => {
    expect(
      toSearchHitResponse({
        documentId: 'd1',
        documentTitle: 'Handbook',
        chunkIndex: 7,
        score: 0.71,
        retrieval: 'both',
        vectorScore: 0.68,
        text: '30 days',
      }),
    ).toEqual({
      document_id: 'd1',
      document_title: 'Handbook',
      chunk_index: 7,
      score: 0.71,
      retrieval: 'both',
      vector_score: 0.68,
      text: '30 days',
    });
  });

  it('omits vector_score for a chunk only the lexical ranking reached', () => {
    // Zero would be a lie of a different kind: it reads as "the vector search
    // looked and hated it", when in fact the vector search never saw it.
    const response = toSearchHitResponse({
      documentId: 'd1',
      documentTitle: 'Handbook',
      chunkIndex: 7,
      score: 0.016,
      retrieval: 'text',
      text: '30 days',
    });

    expect(response).not.toHaveProperty('vector_score');
    expect(response['retrieval']).toBe('text');
  });
});

describe('the ACL body is strict', () => {
  it('refuses an unknown key instead of defaulting the document to public', () => {
    // `is_public` is the casing a client reaches for. Dropped silently, it
    // leaves `public` at its default of true -- a restricted document
    // published to the whole project, with a 201 to say it went fine.
    expect(() =>
      parseRegisterDocument({
        title: 'Salary bands',
        mime_type: 'text/markdown',
        acl: { is_public: false, groups: ['finance'] },
      }),
    ).toThrow(ValidationError);
  });

  it('still accepts the name the contract uses', () => {
    const body = parseRegisterDocument({
      title: 'Salary bands',
      mime_type: 'text/markdown',
      acl: { public: false, groups: ['finance'] },
    });

    expect(body.acl).toEqual({ public: false, groups: ['finance'] });
  });
});

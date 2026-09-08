import { Injectable, Logger } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';

import type { TrimmingSpec } from '../../domain/services/security-trimming.js';
import type { VectorIndex, VectorMatch, VectorPoint } from '../../application/ports.js';

/** Payload fields the filter runs on. Indexed explicitly, or the filter scans. */
const INDEXED_PAYLOAD_FIELDS = ['store_id', 'document_id', 'acl_groups', 'acl_principals'] as const;

/**
 * Qdrant behind the VectorIndex port (ADR-006).
 *
 * This adapter TRANSLATES a TrimmingSpec into a Qdrant filter; it never
 * decides what to filter on. That decision is a domain rule and lives there.
 */
@Injectable()
export class QdrantVectorIndex implements VectorIndex {
  private readonly logger = new Logger(QdrantVectorIndex.name);

  constructor(private readonly client: QdrantClient) {}

  async ensureCollection(input: {
    name: string;
    dimensions: number;
    distance: 'cosine' | 'dot';
  }): Promise<void> {
    const exists = await this.client.collectionExists(input.name);
    if (!exists.exists) {
      await this.client.createCollection(input.name, {
        vectors: {
          size: input.dimensions,
          distance: input.distance === 'dot' ? 'Dot' : 'Cosine',
        },
        // Per Qdrant's multitenancy guidance: no global graph, index per tenant
        // group instead. Tenants are many and each is small relative to the
        // whole, so a single graph across all of them is wasted work.
        hnsw_config: { m: 0, payload_m: 16 },
      });
    }

    // `is_tenant` co-locates one project's points on disk, which is what makes
    // the mandatory project filter cheap rather than merely correct.
    await this.client
      .createPayloadIndex(input.name, {
        field_name: 'project_id',
        field_schema: { type: 'keyword', is_tenant: true },
      })
      .catch((error: unknown) => {
        this.logger.debug(`project_id payload index already present: ${String(error)}`);
      });

    for (const field of INDEXED_PAYLOAD_FIELDS) {
      await this.client
        .createPayloadIndex(input.name, { field_name: field, field_schema: 'keyword' })
        .catch(() => {
          // Creating an existing index is a no-op for us; Qdrant says 4xx.
        });
    }
    await this.client
      .createPayloadIndex(input.name, { field_name: 'version', field_schema: 'integer' })
      .catch(() => undefined);
    await this.client
      .createPayloadIndex(input.name, { field_name: 'acl_public', field_schema: 'bool' })
      .catch(() => undefined);
  }

  async upsert(collection: string, points: readonly VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    await this.client.upsert(collection, {
      wait: true,
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: {
          project_id: point.projectId,
          store_id: point.storeId,
          document_id: point.documentId,
          version: point.version,
          chunk_index: point.chunkIndex,
          ...point.acl,
        },
      })),
    });
  }

  async search(input: {
    collection: string;
    vector: readonly number[];
    limit: number;
    trimming: TrimmingSpec;
    minScore?: number;
  }): Promise<VectorMatch[]> {
    // `query`, not `search`: the client dropped `search` in 1.19.
    const found = await this.client.query(input.collection, {
      query: [...input.vector],
      limit: input.limit,
      // The filter travels WITH the query: Qdrant applies it during the HNSW
      // traversal, so an excluded chunk is never a candidate (ADR-006).
      filter: filterFor(input.trimming),
      with_payload: true,
      ...(input.minScore !== undefined && { score_threshold: input.minScore }),
    });

    return found.points.map((hit) => ({
      documentId: asString(hit.payload?.['document_id']),
      chunkIndex: Number(hit.payload?.['chunk_index'] ?? 0),
      score: hit.score,
    }));
  }

  async deleteOtherVersions(input: {
    collection: string;
    projectId: string;
    documentId: string;
    keepVersion: number;
  }): Promise<void> {
    await this.client.delete(input.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'project_id', match: { value: input.projectId } },
          { key: 'document_id', match: { value: input.documentId } },
        ],
        must_not: [{ key: 'version', match: { value: input.keepVersion } }],
      },
    });
  }

  async deleteDocument(input: {
    collection: string;
    projectId: string;
    documentId: string;
  }): Promise<void> {
    await this.client.delete(input.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'project_id', match: { value: input.projectId } },
          { key: 'document_id', match: { value: input.documentId } },
        ],
      },
    });
  }

  async deleteStore(input: {
    collection: string;
    projectId: string;
    storeId: string;
  }): Promise<void> {
    // `project_id` as well as `store_id`, even though a store id is already
    // unique: the tenant clause is never omitted on a write that deletes, and a
    // filter that matched a store id alone would be one typo from another
    // tenant's vectors.
    await this.client.delete(input.collection, {
      wait: true,
      filter: {
        must: [
          { key: 'project_id', match: { value: input.projectId } },
          { key: 'store_id', match: { value: input.storeId } },
        ],
      },
    });
  }
}

/** A payload value is whatever was stored; only a string is a document id. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The trimming spec as a Qdrant filter.
 *
 * Exported so the translation is testable without a running Qdrant: this is
 * the one place where getting a clause wrong becomes a cross-tenant read.
 */
export function filterFor(spec: TrimmingSpec): Record<string, unknown> {
  return {
    must: [
      // The OWNER's project, whoever is asking. A subscriber reads the owner's
      // chunks, so pinning the reader's project here would match nothing.
      { key: 'project_id', match: { value: spec.projectId } },
      { key: 'store_id', match: { value: spec.storeId } },
      // Reads as: AND (public OR in one of my groups OR named for me).
      // A nested `should` is portable across Qdrant versions, unlike min_should.
      //
      // The identity branches disappear on their own across a project
      // boundary, because the spec hands over empty lists. There is no
      // `crossProject` test here to forget.
      {
        should: [
          { key: 'acl_public', match: { value: true } },
          ...(spec.aclGroups.length > 0
            ? [{ key: 'acl_groups', match: { any: [...spec.aclGroups] } }]
            : []),
          ...(spec.aclPrincipals.length > 0
            ? [{ key: 'acl_principals', match: { any: [...spec.aclPrincipals] } }]
            : []),
        ],
      },
    ],
  };
}

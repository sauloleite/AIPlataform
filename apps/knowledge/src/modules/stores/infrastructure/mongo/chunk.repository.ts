import { Injectable, Logger } from '@nestjs/common';
import type { Collection, Db, Filter } from 'mongodb';

import type { Chunk } from '../../domain/services/chunker.js';
import type { TrimmingSpec } from '../../domain/services/security-trimming.js';
import type { ChunkRepository, StoredChunk, TextMatch } from '../../application/ports.js';

interface ChunkRecord {
  _id: string;
  projectId: string;
  /**
   * Denormalised from the document, like the ACL below.
   *
   * Without it a lexical search could scope to the project but not to the
   * store, and the missing clause would have to be applied to the results --
   * which is the post-filtering ADR-006 exists to forbid.
   */
  storeId: string;
  documentId: string;
  version: number;
  index: number;
  text: string;
  start: number;
  end: number;
  aclPublic: boolean;
  aclGroups: string[];
  aclPrincipals: string[];
}

const TEXT_INDEX = 'chunk_text_v2';
/** The shape this adapter replaced: project-scoped only, and never queried. */
const SUPERSEDED_TEXT_INDEX = 'chunk_text';

function keyOf(documentId: string, version: number, index: number): string {
  return `${documentId}:${version.toString()}:${index.toString()}`;
}

/**
 * Chunk text in MongoDB, plus the lexical half of hybrid search.
 *
 * A lean vector payload keeps the mandatory filter fast, and it means the only
 * sensitive thing in the vector index is the ACL rather than the document
 * body. Search pays one hydration round trip, which it needs anyway for
 * citations.
 */
@Injectable()
export class MongoChunkRepository implements ChunkRepository {
  private readonly logger = new Logger(MongoChunkRepository.name);
  private readonly collection: Collection<ChunkRecord>;

  constructor(db: Db) {
    this.collection = db.collection<ChunkRecord>('chunks');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ documentId: 1, version: 1, index: 1 }, { unique: true });

    // Drop BEFORE create, not after: MongoDB allows exactly one text index per
    // collection, so creating the new one first fails outright on any database
    // that already has the old one. Losing the superseded index for the moment
    // in between costs nothing -- no query ever read it.
    await this.collection.dropIndex(SUPERSEDED_TEXT_INDEX).catch(() => {
      // Absent on a fresh database, which is the common case.
    });

    // The equality prefix is not merely an optimisation: MongoDB REFUSES a
    // $text query against a compound text index unless the query supplies
    // equality on every preceding key. So the tenant and the store cannot be
    // omitted by accident -- the engine rejects the query rather than
    // answering it across projects. That is the same property the port's
    // signature gives, enforced a second time by the storage engine.
    //
    // `none` disables stemming and stop-word removal. The vector ranking is
    // already good at prose; this ranking exists to catch what it misses,
    // which is literal tokens -- an error code, a version, an account number.
    // A stemmer helps the first job and damages the second.
    await this.collection.createIndex(
      { projectId: 1, storeId: 1, text: 'text' },
      { name: TEXT_INDEX, default_language: 'none' },
    );
  }

  async replaceForDocument(input: {
    documentId: string;
    projectId: string;
    storeId: string;
    acl: { acl_public: boolean; acl_groups: string[]; acl_principals: string[] };
    version: number;
    chunks: readonly Chunk[];
  }): Promise<void> {
    // The new version is written before the old is dropped, so a search during
    // reindexing never finds the document missing.
    if (input.chunks.length > 0) {
      await this.collection.bulkWrite(
        input.chunks.map((chunk) => ({
          updateOne: {
            filter: { _id: keyOf(input.documentId, input.version, chunk.index) },
            update: {
              $set: {
                projectId: input.projectId,
                storeId: input.storeId,
                documentId: input.documentId,
                version: input.version,
                index: chunk.index,
                text: chunk.text,
                start: chunk.start,
                end: chunk.end,
                aclPublic: input.acl.acl_public,
                aclGroups: input.acl.acl_groups,
                aclPrincipals: input.acl.acl_principals,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }

    await this.collection.deleteMany({
      documentId: input.documentId,
      version: { $ne: input.version },
    });
  }

  async findMany(input: {
    projectId: string;
    documentId: string;
    version: number;
    indexes: readonly number[];
  }): Promise<StoredChunk[]> {
    const records = await this.collection
      .find({
        projectId: input.projectId,
        documentId: input.documentId,
        version: input.version,
        index: { $in: [...input.indexes] },
      })
      .toArray();

    return records.map((record) => ({
      documentId: record.documentId,
      version: record.version,
      index: record.index,
      text: record.text,
    }));
  }

  async searchText(input: {
    trimming: TrimmingSpec;
    query: string;
    limit: number;
  }): Promise<TextMatch[]> {
    const terms = searchTermsOf(input.query);
    // Every term was punctuation or whitespace. `$text` with an empty string
    // matches nothing, but it costs a round trip to learn that.
    if (terms === '') return [];

    const found = await this.collection
      .find(textQueryFor(input.trimming, terms), {
        projection: { documentId: 1, index: 1, relevance: { $meta: 'textScore' } },
        // The sort and the limit run inside the query, after the filter. An
        // excluded chunk therefore never occupies one of the `limit` slots --
        // the property ADR-006 requires, reached here by the query planner
        // rather than by graph traversal.
        sort: { relevance: { $meta: 'textScore' } },
        limit: Math.max(0, input.limit),
      })
      .toArray();

    return found.map((record) => ({
      documentId: record.documentId,
      chunkIndex: record.index,
      score: (record as { relevance?: number }).relevance ?? 0,
    }));
  }

  async removeForDocument(documentId: string): Promise<void> {
    await this.collection.deleteMany({ documentId });
  }

  async removeForStore(storeId: string): Promise<void> {
    const result = await this.collection.deleteMany({ storeId });
    this.logger.log(`removed ${result.deletedCount.toString()} chunks for store ${storeId}`);
  }
}

/**
 * A $text query built from what MongoDB will actually match on.
 *
 * MongoDB tokenises on delimiters, so a phrase search is the only way to ask
 * for a token that contains one. Quoting every term also stops a term being
 * read as an operator: a leading `-` means "must not contain", and a query
 * pasted from a log could otherwise exclude the very thing it was looking for.
 */
export function searchTermsOf(query: string): string {
  const terms = query
    .split(/\s+/u)
    .map((term) => term.replace(/"/gu, '').trim())
    .filter((term) => term.length > 0);

  return terms.map((term) => `"${term}"`).join(' ');
}

/**
 * The trimming spec as a MongoDB filter.
 *
 * Exported so the translation is testable without a running MongoDB: this is
 * the one place where getting a clause wrong becomes a cross-tenant read. It
 * is the lexical twin of `filterFor` in the Qdrant adapter, and the two must
 * agree -- a chunk one of them admits and the other refuses is a leak in
 * whichever direction it goes.
 */
export function textQueryFor(spec: TrimmingSpec, terms: string): Filter<ChunkRecord> {
  return {
    // The OWNER's project, exactly as the vector filter pins it.
    projectId: spec.projectId,
    storeId: spec.storeId,
    $text: { $search: terms },
    // Reads as: AND (public OR in one of my groups OR named for me). The
    // identity branches vanish across a project boundary because the spec
    // arrives with them empty.
    $or: [
      { aclPublic: true },
      ...(spec.aclGroups.length > 0 ? [{ aclGroups: { $in: [...spec.aclGroups] } }] : []),
      ...(spec.aclPrincipals.length > 0
        ? [{ aclPrincipals: { $in: [...spec.aclPrincipals] } }]
        : []),
    ],
  };
}

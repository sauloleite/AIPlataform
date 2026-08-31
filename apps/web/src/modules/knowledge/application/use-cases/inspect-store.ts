import type { DocumentSummary, KnowledgeGateway, StoreSummary } from '../ports';

export interface StoreCard extends StoreSummary {
  /** Documents still moving through the pipeline. */
  ingestingCount: number;
  failedCount: number;
}

export interface StoreDetail extends StoreCard {
  documents: DocumentSummary[];
}

/** Terminal states; everything else means the worker still has it. */
const TERMINAL = new Set(['ingested', 'failed']);

export function summarise(store: StoreSummary, documents: DocumentSummary[]): StoreDetail {
  return {
    ...store,
    ingestingCount: documents.filter((document) => !TERMINAL.has(document.status)).length,
    failedCount: documents.filter((document) => document.status === 'failed').length,
    documents,
  };
}

export class ListStores {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(accessToken: string, projectId: string): Promise<StoreSummary[]> {
    return this.knowledge.listStores(accessToken, projectId);
  }
}

export class InspectStore {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  async execute(accessToken: string, projectId: string, storeId: string): Promise<StoreDetail> {
    const [store, documents] = await Promise.all([
      this.knowledge.getStore(accessToken, projectId, storeId),
      this.knowledge.listDocuments(accessToken, projectId, storeId),
    ]);
    return summarise(store, documents);
  }
}

/**
 * The catalogue of stores this project could reuse (ADR-023).
 *
 * A store already subscribed is reported rather than hidden, so the screen can
 * say "added" instead of dropping the row somebody just accepted and leaving
 * them wondering whether the click worked.
 */
export class ListCatalogue {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(accessToken: string, projectId: string): Promise<StoreSummary[]> {
    return this.knowledge.listCatalogue(accessToken, projectId);
  }
}

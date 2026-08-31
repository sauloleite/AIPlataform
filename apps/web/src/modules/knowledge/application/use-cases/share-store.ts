import type { KnowledgeGateway, StoreSummary, StoreVisibility } from '../ports';

/**
 * The owner's half: offering a store to other projects (ADR-023).
 *
 * The platform authorises this itself. The console only hides the control
 * from somebody who could not use it, which is a courtesy, not a check.
 */
export class SetStoreVisibility {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(
    accessToken: string,
    projectId: string,
    storeId: string,
    visibility: StoreVisibility,
  ): Promise<StoreSummary> {
    return this.knowledge.setVisibility(accessToken, projectId, storeId, visibility);
  }
}

/** The consumer's half: accepting a published store into this project. */
export class SubscribeToStore {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(accessToken: string, projectId: string, storeId: string): Promise<StoreSummary> {
    return this.knowledge.subscribe(accessToken, projectId, storeId);
  }
}

export class UnsubscribeFromStore {
  constructor(private readonly knowledge: KnowledgeGateway) {}

  execute(accessToken: string, projectId: string, storeId: string): Promise<void> {
    return this.knowledge.unsubscribe(accessToken, projectId, storeId);
  }
}

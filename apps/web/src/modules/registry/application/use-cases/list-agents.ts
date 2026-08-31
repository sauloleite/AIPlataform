import type { AssetSummary, RegistryGateway } from '../ports';

export interface AgentCard extends AssetSummary {
  /**
   * A draft exists above what is published, so somebody edited and has not
   * released it. The registry opens a draft only on the first edit, which is
   * what lets this mean an actual pending change rather than "was published".
   */
  hasUnpublishedChanges: boolean;
  statusLabel: 'published' | 'draft only' | 'unpublished changes';
}

export class ListAgents {
  constructor(private readonly registry: RegistryGateway) {}

  async execute(accessToken: string, projectId: string): Promise<AgentCard[]> {
    const assets = await this.registry.listAssets(accessToken, projectId, 'agent');
    return assets.map(toCard);
  }
}

export function toCard(asset: AssetSummary): AgentCard {
  const published = asset.publishedVersion;
  const draft = asset.draftVersion;
  const hasUnpublishedChanges = published !== null && draft !== null && draft > published;

  return {
    ...asset,
    hasUnpublishedChanges,
    statusLabel:
      published === null
        ? 'draft only'
        : hasUnpublishedChanges
          ? 'unpublished changes'
          : 'published',
  };
}

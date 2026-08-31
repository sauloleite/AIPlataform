import type { AssetDetail, AssetVersionSummary, RegistryGateway } from '../ports';
import { toCard, type AgentCard } from './list-agents';

export interface AgentDetail extends AgentCard {
  /** What a run would execute right now, or undefined if nothing is live. */
  live?: AssetVersionSummary;
  /** What the console edits. */
  draft?: AssetVersionSummary;
  versions: AssetVersionSummary[];
}

export class InspectAgent {
  constructor(private readonly registry: RegistryGateway) {}

  async execute(accessToken: string, projectId: string, assetId: string): Promise<AgentDetail> {
    const detail = await this.registry.getAsset(accessToken, projectId, assetId);
    return toDetail(detail);
  }
}

export function toDetail(detail: AssetDetail): AgentDetail {
  const live = detail.versions.find((v) => v.version === detail.publishedVersion);
  const draft = detail.versions.find((v) => v.version === detail.draftVersion);

  return {
    ...toCard(detail),
    ...(live !== undefined && { live }),
    ...(draft !== undefined && { draft }),
    versions: [...detail.versions].sort((a, b) => b.version - a.version),
  };
}

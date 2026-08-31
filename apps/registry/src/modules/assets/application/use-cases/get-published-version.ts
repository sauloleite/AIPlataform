import { AssetNotFoundError, AssetNotPublishedError } from '../../domain/errors/index.js';
import type { AssetVersionView } from '../dto.js';
import type { AssetRepository, VersionRepository } from '../ports.js';
import { versionView } from '../views.js';

/**
 * What aia-agent-runtime calls at the start of a run (flow 7.2).
 *
 * There is deliberately no fallback to the draft: running a definition nobody
 * published is exactly the drift this service exists to prevent.
 */
export class GetPublishedVersion {
  constructor(
    private readonly assets: AssetRepository,
    private readonly versions: VersionRepository,
  ) {}

  async execute(projectId: string, assetId: string): Promise<AssetVersionView> {
    const asset = await this.assets.findById(projectId, assetId);
    if (asset === null) throw new AssetNotFoundError(assetId, projectId);

    const published = asset.publishedVersion;
    if (published === undefined) throw new AssetNotPublishedError(assetId);

    const version = await this.versions.find(assetId, published);
    if (version === null) throw new AssetNotPublishedError(assetId);

    return versionView(version);
  }
}

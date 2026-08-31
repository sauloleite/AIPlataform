import { AssetNotFoundError } from '../../domain/errors/index.js';
import type { AssetDetailView } from '../dto.js';
import type { AssetRepository, VersionRepository } from '../ports.js';
import { assetView, versionView } from '../views.js';

export class GetAsset {
  constructor(
    private readonly assets: AssetRepository,
    private readonly versions: VersionRepository,
  ) {}

  async execute(projectId: string, assetId: string): Promise<AssetDetailView> {
    const asset = await this.assets.findById(projectId, assetId);
    if (asset === null) throw new AssetNotFoundError(assetId, projectId);

    const versions = await this.versions.listForAsset(assetId);
    return { ...assetView(asset), versions: versions.map(versionView) };
  }
}

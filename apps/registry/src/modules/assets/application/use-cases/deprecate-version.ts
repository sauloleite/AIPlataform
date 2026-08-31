import { EVENT_TYPES, newEvent } from '@aia/messaging';

import { AssetNotFoundError, AssetNotPublishedError } from '../../domain/errors/index.js';
import type { AssetVersionView, DeprecateVersionCommand } from '../dto.js';
import type { AssetRepository, Clock, VersionRepository } from '../ports.js';
import { versionView } from '../views.js';

export class DeprecateVersion {
  constructor(
    private readonly assets: AssetRepository,
    private readonly versions: VersionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: DeprecateVersionCommand): Promise<AssetVersionView> {
    const asset = await this.assets.findById(command.projectId, command.assetId);
    if (asset === null) throw new AssetNotFoundError(command.assetId, command.projectId);

    const version = await this.versions.find(command.assetId, command.version);
    if (version === null) throw new AssetNotPublishedError(command.assetId);

    const now = this.clock.now();
    version.deprecate(now);
    await this.versions.save(version);

    // Deprecating what is currently live leaves the asset with nothing to
    // resolve, which is the honest state: a run would now fail fast rather
    // than execute something the owner withdrew.
    if (asset.publishedVersion === command.version) {
      asset.deprecatePublished(now);
      await this.assets.save(asset, [
        newEvent({
          type: EVENT_TYPES.ASSET_DEPRECATED,
          source: 'aia-registry',
          projectId: command.projectId,
          time: now,
          data: {
            asset_id: asset.id,
            kind: asset.kind,
            slug: asset.slug,
            version: command.version,
          },
        }),
      ]);
    }

    return versionView(version);
  }
}

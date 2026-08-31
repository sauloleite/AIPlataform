import { Asset } from '../../domain/entities/asset.js';
import { AssetVersion } from '../../domain/entities/asset-version.js';
import { SlugTakenError } from '../../domain/errors/index.js';
import type { CreateAssetCommand, AssetVersionView } from '../dto.js';
import type { AssetRepository, Clock, IdGenerator, VersionRepository } from '../ports.js';
import { versionView } from '../views.js';

/** Creates an asset together with its first draft. An asset with no version
 *  would be a row nothing can be done with. */
export class CreateAsset {
  constructor(
    private readonly assets: AssetRepository,
    private readonly versions: VersionRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateAssetCommand): Promise<AssetVersionView> {
    const existing = await this.assets.findBySlug(command.projectId, command.kind, command.slug);
    if (existing !== null) throw new SlugTakenError(command.kind, command.slug);

    const now = this.clock.now();
    const asset = Asset.create({
      id: this.ids.next(),
      projectId: command.projectId,
      kind: command.kind,
      slug: command.slug,
      name: command.name,
      ...(command.description !== undefined && { description: command.description }),
      ownerPrincipalId: command.principalId,
      now,
    });

    const draft = AssetVersion.createDraft({
      assetId: asset.id,
      version: 1,
      kind: command.kind,
      definition: command.definition,
      now,
    });

    // The version first: an asset pointing at a draft that does not exist is
    // worse than a draft nothing points at yet.
    await this.versions.save(draft);
    await this.assets.save(asset);

    return versionView(draft);
  }
}

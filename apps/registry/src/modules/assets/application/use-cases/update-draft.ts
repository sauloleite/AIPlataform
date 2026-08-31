import type { Asset } from '../../domain/entities/asset.js';
import { AssetVersion } from '../../domain/entities/asset-version.js';
import { AssetNotFoundError } from '../../domain/errors/index.js';
import type { AssetVersionView, UpdateDraftCommand } from '../dto.js';
import type { AssetRepository, Clock, VersionRepository } from '../ports.js';
import { versionView } from '../views.js';

export class UpdateDraft {
  constructor(
    private readonly assets: AssetRepository,
    private readonly versions: VersionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: UpdateDraftCommand): Promise<AssetVersionView> {
    const asset = await this.assets.findById(command.projectId, command.assetId);
    if (asset === null) throw new AssetNotFoundError(command.assetId, command.projectId);

    const now = this.clock.now();
    const draftNumber = asset.draftVersion;
    const existing =
      draftNumber === undefined ? null : await this.versions.find(asset.id, draftNumber);

    // No draft yet: the registry opens one on the first edit after publishing.
    if (existing === null) return this.openFreshDraft(asset, command, now);
    // `draftVersion` pointing at something already published is an inconsistent
    // record, not a reason to wall the owner out of their own asset forever.
    if (!existing.isDraft) return this.openFreshDraft(asset, command, now);

    // The entity owns the conflict rule and the validation; this only sequences.
    existing.edit({
      kind: asset.kind,
      definition: command.definition,
      expectedRevision: command.expectedVersion,
      now,
    });
    await this.versions.save(existing);
    await this.renameIfAsked(asset, command, now);

    return versionView(existing);
  }

  /** There is nothing to conflict with on a fresh draft, so no revision check. */
  private async openFreshDraft(
    asset: Asset,
    command: UpdateDraftCommand,
    now: Date,
  ): Promise<AssetVersionView> {
    const version = asset.reopenDraft(now);
    const created = AssetVersion.createDraft({
      assetId: asset.id,
      version,
      kind: asset.kind,
      definition: command.definition,
      now,
    });

    await this.versions.save(created);
    this.applyRename(asset, command, now);
    await this.assets.save(asset);

    return versionView(created);
  }

  private async renameIfAsked(asset: Asset, command: UpdateDraftCommand, now: Date): Promise<void> {
    if (command.name === undefined && command.description === undefined) return;
    this.applyRename(asset, command, now);
    await this.assets.save(asset);
  }

  private applyRename(asset: Asset, command: UpdateDraftCommand, now: Date): void {
    if (command.name === undefined && command.description === undefined) return;
    asset.rename({
      ...(command.name !== undefined && { name: command.name }),
      ...(command.description !== undefined && { description: command.description }),
      now,
    });
  }
}

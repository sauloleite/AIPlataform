import { EVENT_TYPES, newEvent, type CloudEvent } from '@aia/messaging';

import {
  AssetNotFoundError,
  NoDraftError,
  UnresolvedReferenceError,
} from '../../domain/errors/index.js';
import type { AssetDefinition } from '../../domain/value-objects/index.js';
import type { AssetVersionView, PublishVersionCommand } from '../dto.js';
import type { AssetRepository, Clock, ReferenceChecker, VersionRepository } from '../ports.js';
import { versionView } from '../views.js';

const SOURCE = 'aia-registry';

/**
 * Freezes the draft and opens the next one.
 *
 * Every reference the definition makes is resolved HERE. An agent pointing at a
 * vector store that was deleted must fail while someone is looking at a form,
 * not at 3am inside a run.
 */
export class PublishVersion {
  constructor(
    private readonly assets: AssetRepository,
    private readonly versions: VersionRepository,
    private readonly references: ReferenceChecker,
    private readonly clock: Clock,
  ) {}

  async execute(command: PublishVersionCommand): Promise<AssetVersionView> {
    const asset = await this.assets.findById(command.projectId, command.assetId);
    if (asset === null) throw new AssetNotFoundError(command.assetId, command.projectId);

    const draftNumber = asset.draftVersion;
    if (draftNumber === undefined) throw new NoDraftError(command.assetId);

    const draft = await this.versions.find(asset.id, draftNumber);
    if (draft === null) throw new NoDraftError(command.assetId);
    // Publishing something already published would reopen a frozen version.
    if (!draft.isDraft) throw new NoDraftError(command.assetId);

    await this.assertReferencesResolve(command, draft.definition);

    const now = this.clock.now();
    draft.publish({ principalId: command.principalId, now });
    const { published } = asset.publishDraft(now);

    await this.versions.save(draft);
    await this.assets.save(asset, [this.publishedEvent(asset.projectId, asset, published, now)]);

    return versionView(draft);
  }

  private async assertReferencesResolve(
    command: PublishVersionCommand,
    definition: AssetDefinition,
  ): Promise<void> {
    if (definition.kind !== 'agent') return;
    const agent = definition;
    const { projectId, accessToken } = command;

    const unresolved: string[] = [];

    const storeIds = agent.knowledge.map((reference) => reference.storeId);
    if (storeIds.length > 0) {
      const missing = await this.references.storesExist({ projectId, accessToken, storeIds });
      unresolved.push(...missing.map((id) => `vector store ${id}`));
    }

    if (!(await this.references.aliasExists({ projectId, accessToken, alias: agent.modelAlias }))) {
      unresolved.push(`model alias ${agent.modelAlias}`);
    }

    for (const reference of agent.tools) {
      const tool = await this.assets.findById(projectId, reference.assetId);
      if (tool === null) {
        unresolved.push(`tool ${reference.assetId}`);
        continue;
      }
      // A tool with nothing published cannot be invoked, so attaching it would
      // produce an agent that fails on its first tool call.
      if (tool.publishedVersion === undefined) {
        unresolved.push(`tool ${tool.slug} has no published version`);
      }
    }

    if (unresolved.length > 0) throw new UnresolvedReferenceError(unresolved);
  }

  private publishedEvent(
    projectId: string,
    asset: { id: string; kind: string; slug: string },
    version: number,
    now: Date,
  ): CloudEvent {
    return newEvent({
      type: EVENT_TYPES.ASSET_PUBLISHED,
      source: SOURCE,
      projectId,
      time: now,
      data: { asset_id: asset.id, kind: asset.kind, slug: asset.slug, version },
    });
  }
}

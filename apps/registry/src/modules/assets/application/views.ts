import type { Asset } from '../domain/entities/asset.js';
import type { AssetVersion } from '../domain/entities/asset-version.js';
import type { AssetVersionView, AssetView } from './dto.js';

export function assetView(asset: Asset): AssetView {
  const props = asset.snapshot();
  return {
    id: props.id,
    projectId: props.projectId,
    kind: props.kind,
    slug: props.slug,
    name: props.name,
    ...(props.description !== undefined && { description: props.description }),
    ownerPrincipalId: props.ownerPrincipalId,
    publishedVersion: props.publishedVersion ?? null,
    draftVersion: props.draftVersion ?? null,
    createdAt: props.createdAt.toISOString(),
    updatedAt: props.updatedAt.toISOString(),
  };
}

export function versionView(version: AssetVersion): AssetVersionView {
  const props = version.snapshot();
  return {
    assetId: props.assetId,
    version: props.version,
    status: props.status,
    definition: props.definition,
    ...(props.publishedAt !== undefined && { publishedAt: props.publishedAt.toISOString() }),
    ...(props.publishedBy !== undefined && { publishedBy: props.publishedBy }),
    updatedAt: props.updatedAt.toISOString(),
    revision: props.revision,
  };
}

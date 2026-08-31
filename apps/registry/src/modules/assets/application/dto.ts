import type { AssetDefinition, AssetKind, VersionStatus } from '../domain/value-objects/index.js';

export interface CreateAssetCommand {
  projectId: string;
  principalId: string;
  kind: AssetKind;
  slug: string;
  name: string;
  description?: string;
  definition: AssetDefinition;
}

export interface UpdateDraftCommand {
  projectId: string;
  assetId: string;
  definition: AssetDefinition;
  expectedVersion: number;
  name?: string;
  description?: string;
}

export interface PublishVersionCommand {
  projectId: string;
  assetId: string;
  principalId: string;
  /** Publishing resolves references as the caller. See ReferenceChecker. */
  accessToken: string;
}

export interface DeprecateVersionCommand {
  projectId: string;
  assetId: string;
  version: number;
}

export interface AssetVersionView {
  assetId: string;
  version: number;
  status: VersionStatus;
  definition: AssetDefinition;
  publishedAt?: string;
  publishedBy?: string;
  updatedAt: string;
  /** What the next write must echo back. See AssetVersion.edit. */
  revision: number;
}

export interface AssetView {
  id: string;
  projectId: string;
  kind: AssetKind;
  slug: string;
  name: string;
  description?: string;
  ownerPrincipalId: string;
  publishedVersion: number | null;
  draftVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetDetailView extends AssetView {
  versions: AssetVersionView[];
}

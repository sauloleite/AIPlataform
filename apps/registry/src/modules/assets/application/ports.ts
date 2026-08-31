/**
 * Application layer ports.
 *
 * Interfaces plus a Symbol for the Nest token: a use case knows that an asset
 * can be stored and that a store reference can be checked, never that Mongo or
 * HTTP is how.
 */
import type { CloudEvent } from '@aia/messaging';

import type { Asset } from '../domain/entities/asset.js';
import type { AssetVersion } from '../domain/entities/asset-version.js';
import type { AssetKind } from '../domain/value-objects/index.js';

export interface AssetPage {
  items: Asset[];
  nextCursor: string | null;
}

export interface AssetRepository {
  findById(projectId: string, assetId: string): Promise<Asset | null>;
  findBySlug(projectId: string, kind: AssetKind, slug: string): Promise<Asset | null>;
  list(input: {
    projectId: string;
    kind?: AssetKind;
    limit: number;
    cursor?: string;
  }): Promise<AssetPage>;
  /** State and events in one transaction: the outbox pattern, never two writes. */
  save(asset: Asset, events?: readonly CloudEvent[]): Promise<void>;
}
export const ASSET_REPOSITORY = Symbol('AssetRepository');

export interface VersionRepository {
  find(assetId: string, version: number): Promise<AssetVersion | null>;
  listForAsset(assetId: string): Promise<AssetVersion[]>;
  save(version: AssetVersion): Promise<void>;
}
export const VERSION_REPOSITORY = Symbol('VersionRepository');

/**
 * Whether the things a definition points at actually exist.
 *
 * Split by target so the registry never imports another service's domain: it
 * asks over a contract and gets a yes or a no.
 *
 * Every question carries the CALLER's token rather than a service credential.
 * "Does this alias exist" is really "may this project use it", which is a
 * question about the caller -- and answering it as the service would mean
 * granting the registry read access to every project on the platform.
 */
export interface ReferenceChecker {
  /** Vector stores live in aia-knowledge (ADR-016). Returns the MISSING ids. */
  storesExist(input: {
    projectId: string;
    accessToken: string;
    storeIds: readonly string[];
  }): Promise<readonly string[]>;
  /** Model aliases come from the inference-router catalogue. */
  aliasExists(input: { projectId: string; accessToken: string; alias: string }): Promise<boolean>;
}
export const REFERENCE_CHECKER = Symbol('ReferenceChecker');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

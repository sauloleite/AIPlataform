import type { CloudEvent } from '@aia/messaging';

import type { Asset } from '../src/modules/assets/domain/entities/asset.js';
import type { AssetVersion } from '../src/modules/assets/domain/entities/asset-version.js';
import type { AssetKind } from '../src/modules/assets/domain/value-objects/index.js';
import type {
  AssetPage,
  AssetRepository,
  Clock,
  IdGenerator,
  ReferenceChecker,
  VersionRepository,
} from '../src/modules/assets/application/ports.js';

/** Fakes, not mocks: they behave, so a test can assert an outcome rather than
 *  a sequence of calls. */

export class FakeAssetRepository implements AssetRepository {
  readonly saved: Asset[] = [];
  readonly published: CloudEvent[] = [];
  private readonly byId = new Map<string, Asset>();

  findById(projectId: string, assetId: string): Promise<Asset | null> {
    const asset = this.byId.get(assetId);
    // The tenant filter is part of the behaviour, so the fake applies it too.
    // A fake that ignored it would let a cross-tenant test pass vacuously.
    return Promise.resolve(asset?.projectId === projectId ? asset : null);
  }

  findBySlug(projectId: string, kind: AssetKind, slug: string): Promise<Asset | null> {
    for (const asset of this.byId.values()) {
      if (asset.projectId === projectId && asset.kind === kind && asset.slug === slug) {
        return Promise.resolve(asset);
      }
    }
    return Promise.resolve(null);
  }

  list(input: { projectId: string; kind?: AssetKind; limit: number }): Promise<AssetPage> {
    const items = [...this.byId.values()]
      .filter((a) => a.projectId === input.projectId)
      .filter((a) => input.kind === undefined || a.kind === input.kind)
      .slice(0, input.limit);
    return Promise.resolve({ items, nextCursor: null });
  }

  save(asset: Asset, events: readonly CloudEvent[] = []): Promise<void> {
    this.byId.set(asset.id, asset);
    this.saved.push(asset);
    this.published.push(...events);
    return Promise.resolve();
  }

  seed(asset: Asset): void {
    this.byId.set(asset.id, asset);
  }
}

export class FakeVersionRepository implements VersionRepository {
  private readonly byKey = new Map<string, AssetVersion>();

  find(assetId: string, version: number): Promise<AssetVersion | null> {
    return Promise.resolve(this.byKey.get(`${assetId}:${version.toString()}`) ?? null);
  }

  listForAsset(assetId: string): Promise<AssetVersion[]> {
    return Promise.resolve(
      [...this.byKey.values()]
        .filter((v) => v.assetId === assetId)
        .sort((a, b) => a.version - b.version),
    );
  }

  save(version: AssetVersion): Promise<void> {
    this.byKey.set(`${version.assetId}:${version.version.toString()}`, version);
    return Promise.resolve();
  }
}

export class FakeReferenceChecker implements ReferenceChecker {
  knownStores = new Set<string>();
  knownAliases = new Set<string>(['chat-fast']);

  /** Records what identity the checks were made with, so a test can assert
   *  that the CALLER's token is what travels -- not a service credential. */
  readonly seenTokens: string[] = [];

  /** Returns the MISSING ids, matching the port's contract. */
  storesExist(input: {
    projectId: string;
    accessToken: string;
    storeIds: readonly string[];
  }): Promise<readonly string[]> {
    this.seenTokens.push(input.accessToken);
    return Promise.resolve(input.storeIds.filter((id) => !this.knownStores.has(id)));
  }

  aliasExists(input: { projectId: string; accessToken: string; alias: string }): Promise<boolean> {
    this.seenTokens.push(input.accessToken);
    return Promise.resolve(this.knownAliases.has(input.alias));
  }
}

export class FixedClock implements Clock {
  constructor(private readonly value = new Date('2026-08-26T12:00:00Z')) {}
  now(): Date {
    return this.value;
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `id-${this.n.toString()}`;
  }
}

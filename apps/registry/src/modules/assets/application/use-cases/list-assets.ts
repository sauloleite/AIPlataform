import type { AssetKind } from '../../domain/value-objects/index.js';
import type { AssetView } from '../dto.js';
import type { AssetRepository } from '../ports.js';
import { assetView } from '../views.js';

export class ListAssets {
  constructor(private readonly assets: AssetRepository) {}

  async execute(input: {
    projectId: string;
    kind?: AssetKind;
    limit: number;
    cursor?: string;
  }): Promise<{ items: AssetView[]; nextCursor: string | null }> {
    const page = await this.assets.list(input);
    return { items: page.items.map(assetView), nextCursor: page.nextCursor };
  }
}

import { describe, expect, it } from 'vitest';

import { Asset } from '../src/modules/assets/domain/entities/asset.js';
import { fieldsToUnset } from '../src/modules/assets/infrastructure/mongo/asset.repository.js';

const NOW = new Date('2026-08-27T00:00:00Z');

function anAsset(): Asset {
  return Asset.create({
    id: 'a1',
    projectId: 'p1',
    kind: 'agent',
    slug: 'support-agent',
    name: 'Support agent',
    ownerPrincipalId: 'user-1',
    now: NOW,
  });
}

/**
 * These guard a bug that fakes cannot see: `$set` of the remaining keys leaves
 * a cleared field at its old value, so the document keeps claiming state the
 * entity has already left.
 */
describe('fieldsToUnset', () => {
  it('clears the draft once it has been published', () => {
    const asset = anAsset();
    asset.publishDraft(NOW);

    const cleared = fieldsToUnset(asset.snapshot());
    expect(cleared).toHaveProperty('draftVersion');
    expect(cleared).not.toHaveProperty('publishedVersion');
  });

  it('clears the published version once it is deprecated', () => {
    const asset = anAsset();
    asset.publishDraft(NOW);
    asset.deprecatePublished(NOW);

    expect(fieldsToUnset(asset.snapshot())).toHaveProperty('publishedVersion');
  });

  it('clears nothing while both a draft and a published version exist', () => {
    const asset = anAsset();
    asset.publishDraft(NOW);
    asset.openDraft(NOW);

    const cleared = fieldsToUnset(asset.snapshot());
    expect(cleared).not.toHaveProperty('draftVersion');
    expect(cleared).not.toHaveProperty('publishedVersion');
  });

  it('clears a description that was never set', () => {
    expect(fieldsToUnset(anAsset().snapshot())).toHaveProperty('description');
  });
});

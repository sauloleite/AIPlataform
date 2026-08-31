import { describe, expect, it } from 'vitest';

import { Asset } from '../src/modules/assets/domain/entities/asset.js';
import { AssetVersion } from '../src/modules/assets/domain/entities/asset-version.js';
import {
  AssetVersionConflictError,
  InvalidDefinitionError,
  PublishedVersionIsImmutableError,
} from '../src/modules/assets/domain/errors/index.js';
import type { AgentDefinition } from '../src/modules/assets/domain/value-objects/index.js';

const NOW = new Date('2026-08-26T12:00:00Z');

function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    kind: 'agent',
    instructions: 'Answer in one sentence.',
    modelAlias: 'chat-fast',
    tools: [],
    knowledge: [],
    ...overrides,
  };
}

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

describe('Asset.create', () => {
  it('opens with draft version 1 and nothing published', () => {
    const asset = anAsset();
    expect(asset.draftVersion).toBe(1);
    expect(asset.publishedVersion).toBeUndefined();
  });

  it('refuses a slug that would not round-trip in a URL', () => {
    for (const slug of ['A', 'ab', '-lead', 'trail-', 'has space', 'has_underscore']) {
      expect(() => Asset.create({ ...base(), slug })).toThrow(InvalidDefinitionError);
    }
  });

  // An asset with no tenant is the one row that would be visible to everyone.
  it('refuses an asset with no project', () => {
    expect(() => Asset.create({ ...base(), projectId: '  ' })).toThrow(InvalidDefinitionError);
  });

  it('refuses an unnamed asset', () => {
    expect(() => Asset.create({ ...base(), name: '   ' })).toThrow(InvalidDefinitionError);
  });

  function base(): Parameters<typeof Asset.create>[0] {
    return {
      id: 'a1',
      projectId: 'p1',
      kind: 'agent',
      slug: 'support-agent',
      name: 'Support agent',
      ownerPrincipalId: 'user-1',
      now: NOW,
    };
  }
});

describe('publishing', () => {
  // No draft is opened here on purpose: "a draft exists" has to mean somebody
  // edited, or every freshly published asset looks like it has pending changes.
  it('freezes the published version and leaves no open draft', () => {
    const asset = anAsset();
    const { published } = asset.publishDraft(NOW);

    expect(published).toBe(1);
    expect(asset.publishedVersion).toBe(1);
    expect(asset.draftVersion).toBeUndefined();
  });

  it('opens a draft above the published version on the first edit', () => {
    const asset = anAsset();
    asset.publishDraft(NOW);

    expect(asset.openDraft(NOW)).toBe(2);
    expect(asset.draftVersion).toBe(2);
  });

  it('reuses the open draft rather than opening a second one', () => {
    const asset = anAsset();
    asset.publishDraft(NOW);
    const first = asset.openDraft(NOW);

    expect(asset.openDraft(NOW)).toBe(first);
  });

  it('refuses to edit a published version', () => {
    const version = AssetVersion.createDraft({
      assetId: 'a1',
      version: 1,
      kind: 'agent',
      definition: agentDefinition(),
      now: NOW,
    });
    version.publish({ principalId: 'user-1', now: NOW });

    expect(() => {
      version.edit({
        kind: 'agent',
        definition: agentDefinition({ instructions: 'changed' }),
        expectedRevision: 1,
        now: NOW,
      });
    }).toThrow(PublishedVersionIsImmutableError);
  });

  it('refuses to publish twice', () => {
    const version = draft();
    version.publish({ principalId: 'user-1', now: NOW });
    expect(() => {
      version.publish({ principalId: 'user-1', now: NOW });
    }).toThrow(PublishedVersionIsImmutableError);
  });

  it('refuses to deprecate something never published', () => {
    expect(() => {
      draft().deprecate(NOW);
    }).toThrow(PublishedVersionIsImmutableError);
  });
});

describe('concurrent editing', () => {
  // Two editors reading revision 1: the second write must be refused, not
  // silently lose the first one's change.
  it('refuses a write whose expected revision has moved', () => {
    const version = draft();
    version.edit({
      kind: 'agent',
      definition: agentDefinition({ instructions: 'first' }),
      expectedRevision: 1,
      now: NOW,
    });

    expect(() => {
      version.edit({
        kind: 'agent',
        definition: agentDefinition({ instructions: 'second' }),
        expectedRevision: 1,
        now: NOW,
      });
    }).toThrow(AssetVersionConflictError);
    expect((version.definition as AgentDefinition).instructions).toBe('first');
  });

  it('accepts a write that carries the current revision', () => {
    const version = draft();
    version.edit({
      kind: 'agent',
      definition: agentDefinition({ instructions: 'first' }),
      expectedRevision: 1,
      now: NOW,
    });
    version.edit({
      kind: 'agent',
      definition: agentDefinition({ instructions: 'second' }),
      expectedRevision: 2,
      now: NOW,
    });

    expect((version.definition as AgentDefinition).instructions).toBe('second');
    expect(version.revision).toBe(3);
  });
});

function draft(): AssetVersion {
  return AssetVersion.createDraft({
    assetId: 'a1',
    version: 1,
    kind: 'agent',
    definition: agentDefinition(),
    now: NOW,
  });
}

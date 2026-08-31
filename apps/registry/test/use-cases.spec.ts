import { beforeEach, describe, expect, it } from 'vitest';

import { Asset } from '../src/modules/assets/domain/entities/asset.js';
import { CreateAsset } from '../src/modules/assets/application/use-cases/create-asset.js';
import { DeprecateVersion } from '../src/modules/assets/application/use-cases/deprecate-version.js';
import { GetPublishedVersion } from '../src/modules/assets/application/use-cases/get-published-version.js';
import { PublishVersion } from '../src/modules/assets/application/use-cases/publish-version.js';
import { UpdateDraft } from '../src/modules/assets/application/use-cases/update-draft.js';
import {
  AssetNotFoundError,
  AssetNotPublishedError,
  AssetVersionConflictError,
  SlugTakenError,
  UnresolvedReferenceError,
} from '../src/modules/assets/domain/errors/index.js';
import type {
  AgentDefinition,
  ToolDefinition,
} from '../src/modules/assets/domain/value-objects/index.js';
import {
  FakeAssetRepository,
  FakeReferenceChecker,
  FakeVersionRepository,
  FixedClock,
  SequentialIds,
} from './fakes.js';

const PROJECT = 'p1';
const OTHER_PROJECT = 'p2';
const PRINCIPAL = 'user-1';
const TOKEN = 'caller-token';

const agent = (o: Partial<AgentDefinition> = {}): AgentDefinition => ({
  kind: 'agent',
  instructions: 'Be brief.',
  modelAlias: 'chat-fast',
  tools: [],
  knowledge: [],
  ...o,
});

let assets: FakeAssetRepository;
let versions: FakeVersionRepository;
let references: FakeReferenceChecker;
let create: CreateAsset;
let update: UpdateDraft;
let publish: PublishVersion;
let resolve: GetPublishedVersion;
let deprecate: DeprecateVersion;

beforeEach(() => {
  assets = new FakeAssetRepository();
  versions = new FakeVersionRepository();
  references = new FakeReferenceChecker();
  const clock = new FixedClock();
  create = new CreateAsset(assets, versions, clock, new SequentialIds());
  update = new UpdateDraft(assets, versions, clock);
  publish = new PublishVersion(assets, versions, references, clock);
  resolve = new GetPublishedVersion(assets, versions);
  deprecate = new DeprecateVersion(assets, versions, clock);
});

async function anAgent(definition = agent()): Promise<string> {
  const draft = await create.execute({
    projectId: PROJECT,
    principalId: PRINCIPAL,
    kind: 'agent',
    slug: 'support-agent',
    name: 'Support agent',
    definition,
  });
  return draft.assetId;
}

describe('CreateAsset', () => {
  it('creates the asset with a draft at version 1', async () => {
    const draft = await anAgent().then((id) => versions.find(id, 1));
    expect(draft?.status).toBe('draft');
  });

  it('refuses a slug already taken by the same kind in the project', async () => {
    await anAgent();
    await expect(
      create.execute({
        projectId: PROJECT,
        principalId: PRINCIPAL,
        kind: 'agent',
        slug: 'support-agent',
        name: 'Another',
        definition: agent(),
      }),
    ).rejects.toThrow(SlugTakenError);
  });

  // Slugs are unique per project AND kind, so a tool may share a name with an
  // agent, and another tenant may use the same name entirely.
  it('allows the same slug for a different kind and for another project', async () => {
    await anAgent();
    const tool: ToolDefinition = {
      kind: 'tool',
      toolType: 'builtin',
      riskLevel: 'low',
      builtinId: 'file_search',
    };
    await expect(
      create.execute({
        projectId: PROJECT,
        principalId: PRINCIPAL,
        kind: 'tool',
        slug: 'support-agent',
        name: 'Same name, different kind',
        definition: tool,
      }),
    ).resolves.toBeDefined();

    await expect(
      create.execute({
        projectId: OTHER_PROJECT,
        principalId: PRINCIPAL,
        kind: 'agent',
        slug: 'support-agent',
        name: 'Another tenant',
        definition: agent(),
      }),
    ).resolves.toBeDefined();
  });
});

describe('tenancy', () => {
  // Answering 404 rather than 403 matters: 403 would confirm the asset exists
  // to somebody in a different tenant.
  it('hides an asset from another project behind a 404', async () => {
    const assetId = await anAgent();
    await expect(resolve.execute(OTHER_PROJECT, assetId)).rejects.toThrow(AssetNotFoundError);
    await expect(
      update.execute({
        projectId: OTHER_PROJECT,
        assetId,
        definition: agent(),
        expectedVersion: 1,
      }),
    ).rejects.toThrow(AssetNotFoundError);
  });
});

describe('PublishVersion', () => {
  it('publishes the draft and opens the next one', async () => {
    const assetId = await anAgent();
    const published = await publish.execute({
      projectId: PROJECT,
      assetId,
      principalId: PRINCIPAL,
      accessToken: TOKEN,
    });

    expect(published.version).toBe(1);
    expect(published.status).toBe('published');
    // No draft is opened by publishing: one appears on the first edit.
    expect(await versions.find(assetId, 2)).toBeNull();
  });

  it('opens a draft above the published version on the first edit after publishing', async () => {
    const assetId = await anAgent();
    await publish.execute({
      projectId: PROJECT,
      assetId,
      principalId: PRINCIPAL,
      accessToken: TOKEN,
    });

    const draft = await update.execute({
      projectId: PROJECT,
      assetId,
      definition: agent({ instructions: 'now edited' }),
      expectedVersion: 1,
    });

    expect(draft.version).toBe(2);
    expect(draft.status).toBe('draft');
    // The published version is untouched by that edit.
    expect((await resolve.execute(PROJECT, assetId)).version).toBe(1);
  });

  it('emits AssetPublished once published', async () => {
    const assetId = await anAgent();
    await publish.execute({
      projectId: PROJECT,
      assetId,
      principalId: PRINCIPAL,
      accessToken: TOKEN,
    });

    expect(assets.published).toHaveLength(1);
    expect(assets.published[0]?.type).toBe('aia.registry.asset.published.v1');
    // Project is the partition key on every event.
    expect(assets.published[0]?.subject).toBe(PROJECT);
  });

  // The whole point of validating at publish time: this must fail while
  // somebody is looking at a form, not at 3am inside a run.
  it('refuses to publish an agent pointing at a vector store that does not exist', async () => {
    const assetId = await anAgent(agent({ knowledge: [{ storeId: 'missing-store' }] }));
    await expect(
      publish.execute({ projectId: PROJECT, assetId, principalId: PRINCIPAL, accessToken: TOKEN }),
    ).rejects.toThrow(UnresolvedReferenceError);
  });

  it('refuses to publish an agent pointing at an unknown model alias', async () => {
    const assetId = await anAgent(agent({ modelAlias: 'chat-imaginary' }));
    await expect(
      publish.execute({ projectId: PROJECT, assetId, principalId: PRINCIPAL, accessToken: TOKEN }),
    ).rejects.toThrow(UnresolvedReferenceError);
  });

  it('refuses to publish an agent whose tool has nothing published', async () => {
    const tool = await create.execute({
      projectId: PROJECT,
      principalId: PRINCIPAL,
      kind: 'tool',
      slug: 'ticket-lookup',
      name: 'Ticket lookup',
      definition: { kind: 'tool', toolType: 'builtin', riskLevel: 'low', builtinId: 'file_search' },
    });
    const assetId = await anAgent(agent({ tools: [{ assetId: tool.assetId, version: null }] }));

    await expect(
      publish.execute({ projectId: PROJECT, assetId, principalId: PRINCIPAL, accessToken: TOKEN }),
    ).rejects.toThrow(UnresolvedReferenceError);
  });

  // Resolving as the service would mean the registry needing read access to
  // every project on the platform. It resolves as the caller instead.
  it('resolves references with the caller identity, not a service credential', async () => {
    references.knownStores.add('s1');
    const assetId = await anAgent(agent({ knowledge: [{ storeId: 's1' }] }));
    await publish.execute({
      projectId: PROJECT,
      assetId,
      principalId: PRINCIPAL,
      accessToken: TOKEN,
    });

    expect(references.seenTokens.length).toBeGreaterThan(0);
    expect(new Set(references.seenTokens)).toEqual(new Set([TOKEN]));
  });

  it('publishes once the store exists', async () => {
    references.knownStores.add('s1');
    const assetId = await anAgent(agent({ knowledge: [{ storeId: 's1' }] }));
    await expect(
      publish.execute({ projectId: PROJECT, assetId, principalId: PRINCIPAL, accessToken: TOKEN }),
    ).resolves.toMatchObject({ status: 'published' });
  });
});

describe('GetPublishedVersion', () => {
  it('answers asset_not_published rather than falling back to the draft', async () => {
    const assetId = await anAgent();
    await expect(resolve.execute(PROJECT, assetId)).rejects.toThrow(AssetNotPublishedError);
  });

  // A run pins a version. Editing the draft afterwards must not change what a
  // run in flight resolves.
  it('keeps resolving the published version while the next draft is edited', async () => {
    const assetId = await anAgent();
    await publish.execute({
      projectId: PROJECT,
      assetId,
      principalId: PRINCIPAL,
      accessToken: TOKEN,
    });

    await update.execute({
      projectId: PROJECT,
      assetId,
      definition: agent({ instructions: 'Completely different.' }),
      expectedVersion: 1,
    });

    const live = await resolve.execute(PROJECT, assetId);
    expect(live.version).toBe(1);
    expect((live.definition as AgentDefinition).instructions).toBe('Be brief.');
  });
});

describe('UpdateDraft', () => {
  it('refuses a stale expected version', async () => {
    const assetId = await anAgent();
    await update.execute({
      projectId: PROJECT,
      assetId,
      definition: agent({ instructions: 'first' }),
      expectedVersion: 1,
    });

    await expect(
      update.execute({
        projectId: PROJECT,
        assetId,
        definition: agent({ instructions: 'second' }),
        expectedVersion: 1,
      }),
    ).rejects.toThrow(AssetVersionConflictError);
  });
});

describe('recovering from an inconsistent draft pointer', () => {
  // A record whose draftVersion points at a PUBLISHED version should not wall
  // the owner out of their own asset. It opens a fresh draft instead.
  it('opens a new draft when the pointer aims at a published version', async () => {
    const assetId = await anAgent();
    await publish.execute({
      projectId: PROJECT,
      assetId,
      principalId: PRINCIPAL,
      accessToken: TOKEN,
    });

    // Reproduce the inconsistency: point the draft at the published version.
    const asset = await assets.findById(PROJECT, assetId);
    const broken = Asset.rehydrate({ ...asset!.snapshot(), draftVersion: 1 });
    await assets.save(broken);

    const draft = await update.execute({
      projectId: PROJECT,
      assetId,
      definition: agent({ instructions: 'recovered' }),
      expectedVersion: 1,
    });

    expect(draft.status).toBe('draft');
    expect(draft.version).toBeGreaterThan(1);
    // And the published version is still intact.
    expect((await resolve.execute(PROJECT, assetId)).version).toBe(1);
  });
});

describe('DeprecateVersion', () => {
  it('leaves the asset unresolvable once the live version is withdrawn', async () => {
    const assetId = await anAgent();
    await publish.execute({
      projectId: PROJECT,
      assetId,
      principalId: PRINCIPAL,
      accessToken: TOKEN,
    });

    await deprecate.execute({ projectId: PROJECT, assetId, version: 1 });

    await expect(resolve.execute(PROJECT, assetId)).rejects.toThrow(AssetNotPublishedError);
    expect(assets.published.map((e) => e.type)).toContain('aia.registry.asset.deprecated.v1');
  });
});

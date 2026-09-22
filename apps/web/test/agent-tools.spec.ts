import { describe, expect, it } from 'vitest';

import {
  parseStoreReferences,
  playgroundContext,
  parseToolReferences,
  toolChoices,
  toolReferencesFor,
  type AttachableTool,
} from '../src/modules/registry/domain/agent-tools';
import {
  ListAttachableTools,
  ListTools,
} from '../src/modules/tools/application/use-cases/inspect-tools';
import type {
  Binding,
  BuiltinTool,
  ConnectionSummary,
  EffectiveTool,
  ToolsGateway,
} from '../src/modules/tools/application/ports';

/**
 * Attaching tools to an agent from the editor.
 *
 * The regression this guards: the form used to save `tools: []` and
 * `knowledge: []` every time, so fixing a typo in an agent's instructions
 * silently detached everything it had been given through the API.
 */

const WEB_SEARCH: AttachableTool = {
  toolId: 'builtin.web_search',
  name: 'Web search',
  description: 'Searches the public web',
  source: 'platform',
  riskLevel: 'low',
};
const TICKETS: AttachableTool = {
  toolId: 'asset-tickets',
  name: 'Ticket lookup',
  source: 'registry',
  riskLevel: 'medium',
};

describe('toolChoices', () => {
  it('offers every tool the project may invoke, ticking the ones already attached', () => {
    const choices = toolChoices([WEB_SEARCH, TICKETS], [{ assetId: 'asset-tickets', version: 3 }]);

    expect(choices.map((choice) => [choice.toolId, choice.attached, choice.available])).toEqual([
      ['builtin.web_search', false, true],
      ['asset-tickets', true, true],
    ]);
  });

  it('keeps an attachment the project can no longer run, ticked and marked unavailable', () => {
    // Dropping it from the list would drop it from the agent on the next save,
    // without anybody deciding to.
    const choices = toolChoices([WEB_SEARCH], [{ assetId: 'builtin.web_fetch', version: null }]);

    expect(choices.at(-1)).toEqual({
      toolId: 'builtin.web_fetch',
      name: 'builtin.web_fetch',
      attached: true,
      available: false,
    });
  });

  it('offers nothing when the project may invoke nothing and nothing is attached', () => {
    expect(toolChoices([], [])).toEqual([]);
  });
});

describe('toolReferencesFor', () => {
  it('keeps the version a tool was pinned to, and leaves a newly ticked one unpinned', () => {
    const saved = toolReferencesFor(
      ['asset-tickets', 'builtin.web_search'],
      [{ assetId: 'asset-tickets', version: 3 }],
    );

    expect(saved).toEqual([
      { assetId: 'asset-tickets', version: 3 },
      { assetId: 'builtin.web_search', version: null },
    ]);
  });

  it('detaches what was unticked', () => {
    expect(toolReferencesFor([], [{ assetId: 'asset-tickets', version: 3 }])).toEqual([]);
  });

  it('saves a tool ticked twice once, because the registry refuses a duplicate', () => {
    expect(toolReferencesFor(['builtin.calculator', ' builtin.calculator ', ''], [])).toEqual([
      { assetId: 'builtin.calculator', version: null },
    ]);
  });
});

describe('what the form carries back', () => {
  it('reads the references it rendered', () => {
    expect(
      parseToolReferences('[{"assetId":"a1","version":2},{"assetId":"a2","version":null}]'),
    ).toEqual([
      { assetId: 'a1', version: 2 },
      { assetId: 'a2', version: null },
    ]);
    expect(parseStoreReferences('[{"storeId":"s1"}]')).toEqual([{ storeId: 's1' }]);
  });

  it.each([
    ['an empty field', ''],
    ['something that is not JSON', '{nope'],
    ['JSON that is not a list', '{"assetId":"a1"}'],
  ])('reads %s as nothing, rather than throwing', (_case, raw) => {
    expect(parseToolReferences(raw)).toEqual([]);
    expect(parseStoreReferences(raw)).toEqual([]);
  });

  it('drops entries that are not the shape the page rendered', () => {
    expect(
      parseToolReferences(
        '[{"assetId":""},{"assetId":7},null,"a1",{"assetId":"ok","version":-1},{"assetId":"v","version":1.5}]',
      ),
    ).toEqual([
      { assetId: 'ok', version: null },
      { assetId: 'v', version: null },
    ]);
    expect(parseStoreReferences('[{"storeId":""},{"storeId":3},{"storeId":"s2"}]')).toEqual([
      { storeId: 's2' },
    ]);
  });
});

describe('playgroundContext', () => {
  it('says the published version runs, and that without tools it cannot reach the web', () => {
    // The confusion this answers: an agent with no tools, asked to open a URL,
    // replies that it cannot browse -- and nothing on screen said why.
    expect(
      playgroundContext({ liveVersion: 1, liveToolNames: [], hasUnpublishedChanges: false }),
    ).toEqual({
      runs: 'Runs published v1, with no tools, so it cannot search the web or call anything.',
    });
  });

  it('names the tools the published version may call', () => {
    expect(
      playgroundContext({
        liveVersion: 3,
        liveToolNames: ['Web search', 'Web page reader'],
        hasUnpublishedChanges: false,
      }).runs,
    ).toBe('Runs published v3, with tools: Web search, Web page reader.');
  });

  it('warns when the draft being edited is not what runs', () => {
    expect(
      playgroundContext({ liveVersion: 1, liveToolNames: [], hasUnpublishedChanges: true }).warning,
    ).toContain('Publish to try them here');
  });
});

/** The tools gateway as far as listing goes. */
class FakeToolsGateway implements ToolsGateway {
  constructor(
    private readonly effective: EffectiveTool[],
    private readonly builtins: BuiltinTool[] = [],
  ) {}

  async listEffective(): Promise<EffectiveTool[]> {
    return this.effective;
  }
  async listBuiltins(): Promise<BuiltinTool[]> {
    return this.builtins;
  }
  async listConnections(): Promise<ConnectionSummary[]> {
    return [];
  }
  async createConnection(): Promise<ConnectionSummary> {
    throw new Error('not used');
  }
  async deleteConnection(): Promise<void> {
    // Not used by a listing.
  }
  async listBindings(): Promise<Binding[]> {
    return [];
  }
  async bind(): Promise<Binding> {
    throw new Error('not used');
  }
  async unbind(): Promise<void> {
    // Not used by a listing.
  }
}

const effective = (o: Partial<EffectiveTool>): EffectiveTool => ({
  toolId: 't',
  slug: 't',
  name: 'T',
  toolType: 'mcp',
  source: 'registry',
  riskLevel: 'low',
  requiresApproval: false,
  rateLimitPerMinute: 60,
  ...o,
});

describe('ListTools', () => {
  it('lists built-ins once, in their own section, and not again among project tools', async () => {
    const builtin: BuiltinTool = {
      toolId: 'builtin.calculator',
      slug: 'calculator',
      name: 'Calculator',
      description: 'Arithmetic',
      builtinId: 'calculator',
      riskLevel: 'low',
      dataZone: 'local',
      enabled: true,
      available: true,
      unavailableReason: null,
      requiresApproval: false,
      rateLimitPerMinute: 60,
    };
    const gateway = new FakeToolsGateway(
      [
        effective({ toolId: 'builtin.calculator', source: 'platform', toolType: 'builtin' }),
        effective({ toolId: 'asset-tickets' }),
      ],
      [builtin],
    );

    const view = await new ListTools(gateway).execute('token', 'p1');

    expect(view.builtins).toEqual([builtin]);
    expect(view.projectTools.map((tool) => tool.toolId)).toEqual(['asset-tickets']);
  });
});

describe('ListAttachableTools', () => {
  it('puts the built-ins first, then the rest by name', async () => {
    const gateway = new FakeToolsGateway([
      effective({ toolId: 'z', name: 'Zendesk' }),
      effective({ toolId: 'builtin.web_search', name: 'Web search', source: 'platform' }),
      effective({ toolId: 'a', name: 'Asana' }),
      effective({ toolId: 'builtin.calculator', name: 'Calculator', source: 'platform' }),
    ]);

    const tools = await new ListAttachableTools(gateway).execute('token', 'p1');

    expect(tools.map((tool) => tool.toolId)).toEqual([
      'builtin.calculator',
      'builtin.web_search',
      'a',
      'z',
    ]);
  });
});

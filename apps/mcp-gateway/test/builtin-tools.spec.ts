import { beforeEach, describe, expect, it } from 'vitest';

import { InvokeTool } from '../src/modules/tools/application/use-cases/invoke-tool.js';
import { ListBuiltinTools } from '../src/modules/tools/application/use-cases/list-builtin-tools.js';
import { ListEffectiveTools } from '../src/modules/tools/application/use-cases/list-effective-tools.js';
import { BindTool } from '../src/modules/tools/application/use-cases/manage-bindings.js';
import { ToolBinding } from '../src/modules/tools/domain/entities/tool-binding.js';
import {
  InvalidToolArgumentsError,
  ToolExecutionFailedError,
  ToolNotAllowedError,
  ToolNotFoundError,
  ToolRateLimitedError,
} from '../src/modules/tools/domain/errors/index.js';
import {
  BUILTIN_TOOLS,
  builtinToolId,
} from '../src/modules/tools/domain/value-objects/builtin-tools.js';
import type { ToolDefinition } from '../src/modules/tools/domain/value-objects/index.js';
import {
  FakeApprovalStore,
  FakeAuditRepository,
  FakeBindingRepository,
  FakeClassificationReader,
  FakeConnectionRepository,
  FakeExecutor,
  FakeRateLimiter,
  FakeSecretResolver,
  FakeToolCatalog,
  NOW,
  PROJECT,
  SequentialIds,
  TOKEN,
  fixedClock,
  principal,
} from './fakes.js';

/**
 * The platform's built-in tools (ADR-024): present in every project without
 * anyone creating them, and still governed like every other tool.
 *
 * The happy path is one test. The rest is what must NOT happen: a built-in the
 * project switched off still running, web search reaching the internet from a
 * confidential project, a tool offered to a model that fails on its first call.
 */

const WEB_SEARCH = builtinToolId('web_search');
const CALCULATOR = builtinToolId('calculator');
const CALLER = principal(['project_editor']);

const REGISTRY_TOOL: ToolDefinition = {
  toolId: 'asset-ticket-lookup',
  slug: 'ticket-lookup',
  name: 'Ticket lookup',
  toolType: 'mcp',
  source: 'registry',
  riskLevel: 'low',
  endpoint: 'https://tools.example/mcp',
};

let catalog: FakeToolCatalog;
let bindings: FakeBindingRepository;
let limiter: FakeRateLimiter;
let audit: FakeAuditRepository;
let governance: FakeClassificationReader;
let builtins: FakeExecutor;
let external: FakeExecutor;

function executors(): FakeExecutor[] {
  return [external, builtins];
}

function invokeTool(): InvokeTool {
  return new InvokeTool(
    catalog,
    bindings,
    limiter,
    new FakeApprovalStore(),
    executors(),
    new FakeConnectionRepository(),
    new FakeSecretResolver(),
    governance,
    audit,
    fixedClock,
    new SequentialIds(),
  );
}

function invoke(toolId: string, args: Record<string, unknown> = {}, caller = CALLER) {
  return invokeTool().execute(
    { projectId: PROJECT, toolId, principalId: caller.id, accessToken: TOKEN, arguments: args },
    caller,
  );
}

function effective(caller = CALLER) {
  return new ListEffectiveTools(catalog, bindings, executors(), governance).execute({
    projectId: PROJECT,
    accessToken: TOKEN,
    principal: caller,
  });
}

function administrative() {
  return new ListBuiltinTools(bindings, executors(), governance).execute({
    projectId: PROJECT,
    accessToken: TOKEN,
    principal: CALLER,
  });
}

async function switchOff(toolId: string): Promise<void> {
  await bindings.save(ToolBinding.create({ projectId: PROJECT, toolId, enabled: false, now: NOW }));
}

beforeEach(() => {
  catalog = new FakeToolCatalog();
  bindings = new FakeBindingRepository();
  limiter = new FakeRateLimiter();
  audit = new FakeAuditRepository();
  governance = new FakeClassificationReader('internal');
  builtins = new FakeExecutor((tool) => tool.source === 'platform');
  external = new FakeExecutor((tool) => tool.toolType === 'mcp');
});

describe('a built-in in a project nobody configured', () => {
  it('runs without anyone creating or binding it', async () => {
    const result = await invoke(CALCULATOR, { expression: '1 + 1' });

    expect(result.status).toBe('ok');
    expect(builtins.invocations[0]?.tool.toolId).toBe(CALCULATOR);
    // Governed like any other tool: audited with the caller, rate counted.
    expect(audit.records.at(-1)).toMatchObject({
      status: 'ok',
      principalId: 'user-ana',
      toolId: CALCULATOR,
    });
    expect(limiter.consumed.get(`${PROJECT}:${CALCULATOR}`)).toBe(1);
  });

  it('is listed with every built-in, alongside nothing else', async () => {
    const tools = await effective();

    expect(tools.map((tool) => tool.toolId).sort()).toEqual(
      BUILTIN_TOOLS.map((tool) => tool.toolId).sort(),
    );
    expect(tools.every((tool) => tool.source === 'platform')).toBe(true);
    expect(tools.find((tool) => tool.toolId === WEB_SEARCH)?.rateLimitPerMinute).toBe(60);
  });

  it('never asks the registry about a built-in id', async () => {
    // A registry outage must not take the platform's own tools down with it.
    await invoke(CALCULATOR, { expression: '2' });

    expect(catalog.lookups).toBe(0);
  });

  it('refuses a built-in id the platform does not have', async () => {
    await expect(invoke('builtin.code_interpreter')).rejects.toThrow(ToolNotFoundError);
    await expect(invoke('builtin.nonsense')).rejects.toThrow(ToolNotFoundError);
  });
});

describe('a project that switched a built-in off', () => {
  beforeEach(async () => {
    await switchOff(WEB_SEARCH);
  });

  it('refuses the call and audits the refusal', async () => {
    await expect(invoke(WEB_SEARCH, { query: 'news' })).rejects.toThrow(ToolNotAllowedError);

    expect(builtins.invocations).toHaveLength(0);
    expect(audit.records.at(-1)).toMatchObject({ status: 'denied', errorCode: 'tool_not_allowed' });
    // Refused before the rate: a refusal spends nobody's allowance.
    expect(limiter.consumed.size).toBe(0);
  });

  it('no longer offers it to a model', async () => {
    const tools = await effective();

    expect(tools.map((tool) => tool.toolId)).not.toContain(WEB_SEARCH);
    expect(tools.map((tool) => tool.toolId)).toContain(CALCULATOR);
  });

  it('still shows it to the administrator, switched off, so it can be switched back on', async () => {
    const view = (await administrative()).find((tool) => tool.toolId === WEB_SEARCH);

    expect(view).toMatchObject({ enabled: false, available: true });
  });

  it('runs it again once the binding is removed, because the default is back', async () => {
    await bindings.remove(PROJECT, WEB_SEARCH);

    await expect(invoke(WEB_SEARCH, { query: 'news' })).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('a binding on a built-in tightens, and never loosens', () => {
  it('applies the binding’s own rate', async () => {
    await bindings.save(
      ToolBinding.create({
        projectId: PROJECT,
        toolId: CALCULATOR,
        rateLimitPerMinute: 1,
        now: NOW,
      }),
    );

    await invoke(CALCULATOR, { expression: '1' });
    await expect(invoke(CALCULATOR, { expression: '1' })).rejects.toThrow(ToolRateLimitedError);
  });
});

describe('ADR-010: a built-in that sends data off the platform', () => {
  it.each(['confidential', 'restricted'])('is refused in a %s project', async (classification) => {
    governance.classification = classification;

    await expect(invoke(WEB_SEARCH, { query: 'our quarterly numbers' })).rejects.toThrow(
      ToolNotAllowedError,
    );
    expect(builtins.invocations).toHaveLength(0);
    expect(audit.records.at(-1)).toMatchObject({ status: 'denied' });
  });

  it.each(['public', 'internal'])('runs in a %s project', async (classification) => {
    governance.classification = classification;

    await expect(invoke(WEB_SEARCH, { query: 'weather' })).resolves.toMatchObject({ status: 'ok' });
  });

  it('is not offered to a model in a confidential project, while local built-ins still are', async () => {
    governance.classification = 'confidential';
    const ids = (await effective()).map((tool) => tool.toolId);

    expect(ids).not.toContain(WEB_SEARCH);
    expect(ids).not.toContain(builtinToolId('web_fetch'));
    expect(ids).toContain(CALCULATOR);
    expect(ids).toContain(builtinToolId('file_search'));
  });

  it('tells the administrator why, in words that name the classification', async () => {
    governance.classification = 'restricted';
    const view = (await administrative()).find((tool) => tool.toolId === WEB_SEARCH);

    expect(view?.available).toBe(false);
    expect(view?.unavailableReason).toContain('restricted');
  });

  it('is refused when the classification cannot be read -- fail closed', async () => {
    governance.classification = null;

    await expect(invoke(WEB_SEARCH, { query: 'weather' })).rejects.toThrow(ToolNotAllowedError);
  });

  it('costs only the tools that needed governance when governance is down', async () => {
    governance.classification = null;
    const ids = (await effective()).map((tool) => tool.toolId);

    expect(ids).not.toContain(WEB_SEARCH);
    expect(ids).toContain(CALCULATOR);
  });

  it('does not ask governance at all for a tool that stays on the platform', async () => {
    await invoke(CALCULATOR, { expression: '3' });

    expect(governance.reads).toBe(0);
  });
});

describe('a built-in this platform has no backend for', () => {
  beforeEach(() => {
    builtins.unavailable =
      'No web search backend is configured on this platform (WEB_SEARCH_PROVIDER)';
  });

  it('is not offered to a model', async () => {
    expect((await effective()).map((tool) => tool.toolId)).not.toContain(WEB_SEARCH);
  });

  it('fails before the rate is spent or anyone is asked to approve', async () => {
    await expect(invoke(WEB_SEARCH, { query: 'news' })).rejects.toThrow(ToolExecutionFailedError);

    expect(limiter.consumed.size).toBe(0);
    expect(audit.records.at(-1)).toMatchObject({
      status: 'failed',
      errorCode: 'tool_execution_failed',
    });
  });

  it('shows the operator the setting to fix, ahead of anything about the project', async () => {
    governance.classification = 'restricted';
    const view = (await administrative()).find((tool) => tool.toolId === WEB_SEARCH);

    expect(view?.unavailableReason).toContain('WEB_SEARCH_PROVIDER');
  });
});

describe('a model calling a built-in badly', () => {
  it('gets the validation error as it is, not an endpoint failure', async () => {
    builtins = new FakeExecutor(
      (tool) => tool.source === 'platform',
      async (invocation) => {
        throw new InvalidToolArgumentsError(
          invocation.tool.toolId,
          'calculator needs an expression',
        );
      },
    );

    const failure = invoke(CALCULATOR, {});
    await expect(failure).rejects.toThrow(InvalidToolArgumentsError);
    await expect(failure).rejects.toThrow('calculator needs an expression');
    expect(audit.records.at(-1)).toMatchObject({
      status: 'failed',
      errorCode: 'validation_failed',
    });
  });
});

describe('registry tools are unchanged', () => {
  beforeEach(() => {
    catalog.tools.push(REGISTRY_TOOL);
  });

  it('still do nothing until a project binds them', async () => {
    await expect(invoke(REGISTRY_TOOL.toolId)).rejects.toThrow(ToolNotAllowedError);
    expect((await effective()).map((tool) => tool.toolId)).not.toContain(REGISTRY_TOOL.toolId);
  });

  it('run once bound, reported as coming from the registry', async () => {
    await bindings.save(
      ToolBinding.create({ projectId: PROJECT, toolId: REGISTRY_TOOL.toolId, now: NOW }),
    );

    await expect(invoke(REGISTRY_TOOL.toolId)).resolves.toMatchObject({ status: 'ok' });
    expect((await effective()).find((tool) => tool.toolId === REGISTRY_TOOL.toolId)?.source).toBe(
      'registry',
    );
  });

  it('keep their slug when it collides with a built-in, and the built-in steps aside', async () => {
    // Agents already attached to the project's own `web-search` were built
    // against it; two declarations with one name would leave the model to guess.
    const own = { ...REGISTRY_TOOL, toolId: 'asset-own-search', slug: 'web-search' };
    catalog.tools.push(own);
    await bindings.save(ToolBinding.create({ projectId: PROJECT, toolId: own.toolId, now: NOW }));

    const withSlug = (await effective()).filter((tool) => tool.slug === 'web-search');

    expect(withSlug.map((tool) => tool.toolId)).toEqual(['asset-own-search']);
  });
});

describe('BindTool', () => {
  function bind(toolId: string, enabled: boolean) {
    return new BindTool(catalog, bindings, fixedClock).execute({
      projectId: PROJECT,
      toolId,
      accessToken: TOKEN,
      enabled,
    });
  }

  it('binds a built-in, which is how a project switches one off', async () => {
    await bind(WEB_SEARCH, false);

    expect((await bindings.find(PROJECT, WEB_SEARCH))?.enabled).toBe(false);
  });

  it('refuses to bind a built-in that does not exist', async () => {
    await expect(bind('builtin.teleport', false)).rejects.toThrow(ToolNotFoundError);
  });
});

import { describe, expect, it } from 'vitest';

import type { ToolInvocation } from '../src/modules/tools/application/ports.js';
import { InvalidToolArgumentsError } from '../src/modules/tools/domain/errors/index.js';
import {
  BUILTIN_IDS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_PREFIX,
  builtinToolId,
  findBuiltinTool,
} from '../src/modules/tools/domain/value-objects/builtin-tools.js';
import { CalculatorExecutor } from '../src/modules/tools/infrastructure/executors/calculator-executor.js';
import { CurrentTimeExecutor } from '../src/modules/tools/infrastructure/executors/current-time-executor.js';
import { loadConfig } from '../src/config/index.js';

/** The built-ins that need nothing outside the process, and the catalogue itself. */

const NOW = new Date('2026-09-15T14:30:05Z');

function invocationOf(builtin: string, args: Record<string, unknown>): ToolInvocation {
  return {
    tool: findBuiltinTool(builtinToolId(builtin as (typeof BUILTIN_IDS)[number]))!,
    arguments: args,
    accessToken: 'caller-token',
    projectId: 'p1',
    principalId: 'user-ana',
  };
}

describe('the catalogue', () => {
  it('gives every built-in an id no registry asset can take', () => {
    // Registry ids are UUIDs, and a UUID has no dot.
    for (const tool of BUILTIN_TOOLS)
      expect(tool.toolId.startsWith(BUILTIN_TOOL_PREFIX)).toBe(true);
  });

  it('gives every built-in a slug that survives a provider round trip', () => {
    for (const tool of BUILTIN_TOOLS)
      expect(tool.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
  });

  it('declares, for every built-in, where its arguments go', () => {
    // A built-in without a zone would skip the classification check silently.
    for (const tool of BUILTIN_TOOLS) expect(['local', 'global']).toContain(tool.dataZone);
  });

  it('describes every built-in to the model, and gives it a schema', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('has one definition per built-in id, and only the ones it lists', () => {
    expect(BUILTIN_TOOLS.map((tool) => tool.builtinId).sort()).toEqual([...BUILTIN_IDS].sort());
    expect(findBuiltinTool('asset-123')).toBeNull();
    expect(findBuiltinTool('builtin.code_interpreter')).toBeNull();
  });
});

describe('current-time', () => {
  const clock = { now: () => NOW };

  it('answers in UTC when no time zone is asked for', async () => {
    const { result } = await new CurrentTimeExecutor(clock).execute(
      invocationOf('current_time', {}),
    );

    expect(result).toEqual({
      utc: '2026-09-15T14:30:05.000Z',
      unix_seconds: 1789482605,
      weekday_utc: 'Tuesday',
    });
  });

  it('answers in the time zone asked for, with its offset', async () => {
    const { result } = await new CurrentTimeExecutor(clock).execute(
      invocationOf('current_time', { timezone: 'America/Sao_Paulo' }),
    );

    expect(result).toMatchObject({
      timezone: 'America/Sao_Paulo',
      local: '2026-09-15T11:30:05-03:00',
      weekday: 'Tuesday',
    });
  });

  it('writes a zero offset as Z', async () => {
    const { result } = await new CurrentTimeExecutor(clock).execute(
      invocationOf('current_time', { timezone: 'Etc/UTC' }),
    );

    expect((result as { local: string }).local).toBe('2026-09-15T14:30:05Z');
  });

  it('refuses a time zone that does not exist, rather than answering in UTC', async () => {
    await expect(
      new CurrentTimeExecutor(clock).execute(
        invocationOf('current_time', { timezone: 'Mars/Olympus' }),
      ),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  it('refuses a time zone that is not a string', async () => {
    await expect(
      new CurrentTimeExecutor(clock).execute(invocationOf('current_time', { timezone: 3 })),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });
});

describe('calculator', () => {
  it('returns the expression with its result', async () => {
    const { result } = await new CalculatorExecutor().execute(
      invocationOf('calculator', { expression: '1250 * 0.15' }),
    );

    expect(result).toEqual({ expression: '1250 * 0.15', result: 187.5 });
  });

  it('turns a bad expression into a bad argument the model can correct', async () => {
    const failure = new CalculatorExecutor().execute(
      invocationOf('calculator', { expression: '2 +* 3' }),
    );

    await expect(failure).rejects.toThrow(InvalidToolArgumentsError);
  });

  it('refuses an expression that is not a string', async () => {
    await expect(
      new CalculatorExecutor().execute(invocationOf('calculator', { expression: 42 })),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });
});

describe('configuration', () => {
  const BASE = {
    MONGO_URI: 'mongodb://mongo:27017',
    REDIS_URL: 'redis://redis:6379',
    IDENTITY_ISSUER: 'http://identity:3001',
  };

  it('starts with web search switched off and web-fetch on', () => {
    const config = loadConfig(BASE);

    expect(config.WEB_SEARCH_PROVIDER).toBe('none');
    expect(config.WEB_FETCH_ENABLED).toBe(true);
  });

  it('reads WEB_FETCH_ENABLED=false as false, which a boolean coercion would not', () => {
    expect(loadConfig({ ...BASE, WEB_FETCH_ENABLED: 'false' }).WEB_FETCH_ENABLED).toBe(false);
  });

  it('does not start when SearXNG is chosen without saying where it is', () => {
    expect(() => loadConfig({ ...BASE, WEB_SEARCH_PROVIDER: 'searxng' })).toThrow(
      /WEB_SEARCH_SEARXNG_URL/,
    );
  });

  it('does not start on a provider it does not know', () => {
    expect(() => loadConfig({ ...BASE, WEB_SEARCH_PROVIDER: 'altavista' })).toThrow();
  });

  it('refuses a Tavily secret reference that is a path', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        WEB_SEARCH_PROVIDER: 'tavily',
        WEB_SEARCH_TAVILY_SECRET_REF: '../key',
      }),
    ).toThrow();
  });
});

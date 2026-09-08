import { describe, expect, it } from 'vitest';
import { CreateChatCompletion } from '../src/modules/completions/application/use-cases/create-chat-completion.js';
import { DeploymentExecutor } from '../src/modules/completions/application/services/deployment-executor.js';
import { ToolCallAccumulator } from '../src/modules/completions/infrastructure/providers/openai-tools.js';
import type {
  ChatCompletionResult,
  CreateChatCompletionCommand,
} from '../src/modules/completions/application/dto.js';
import { aDeployment, anAlias } from './builders.js';
import {
  CountingBulkhead,
  FakeAliasRegistry,
  FakeAuditRepository,
  FakeBudgetLedger,
  FakeGuardrail,
  FakeModelProvider,
  FakePolicyReader,
  FakeSemanticCache,
  FakeUsagePublisher,
  FixedClock,
  WordTokenEstimator,
} from './fakes.js';

/**
 * Tool calling on the router.
 *
 * The router never RUNS a tool: it reports what the model asked for and the
 * caller — aia-agent-runtime, through aia-mcp-gateway — decides whether that is
 * allowed. These tests pin the two halves of that: the declarations reach the
 * provider, and the calls come back out intact.
 */

const OPENAI = aDeployment({ id: 'openai-us', provider: 'openai', dataZone: 'us', priority: 0 });

const SEARCH_TOOL = {
  name: 'file_search',
  description: 'Searches a vector store',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
};

function build(): {
  useCase: CreateChatCompletion;
  bulkhead: CountingBulkhead;
  openai: FakeModelProvider;
  cache: FakeSemanticCache;
} {
  const openai = new FakeModelProvider('openai');
  const cache = new FakeSemanticCache();

  const bulkhead = new CountingBulkhead();
  const useCase = new CreateChatCompletion(
    new FakePolicyReader(),
    new FakeAliasRegistry([anAlias([OPENAI])]),
    new FakeBudgetLedger(),
    new FakeGuardrail(),
    cache,
    new WordTokenEstimator(),
    new FakeAuditRepository(),
    new FakeUsagePublisher(),
    new FixedClock(),
    bulkhead,
    new DeploymentExecutor([openai]),
  );

  return { useCase, bulkhead, openai, cache };
}

function aCommand(
  overrides: Partial<CreateChatCompletionCommand> = {},
): CreateChatCompletionCommand {
  return {
    requestId: 'req-1',
    projectId: 'proj-1',
    principalId: 'user-ana',
    alias: 'chat-fast',
    messages: [{ role: 'user', content: 'what does the handbook say' }],
    stream: false,
    ...overrides,
  };
}

describe('tool declarations reaching the provider', () => {
  it('passes the tools and the choice through untouched', async () => {
    const { useCase, openai } = build();

    await useCase.execute(aCommand({ tools: [SEARCH_TOOL], toolChoice: 'required' }));

    expect(openai.calls[0]?.request.tools).toEqual([SEARCH_TOOL]);
    expect(openai.calls[0]?.request.toolChoice).toBe('required');
  });

  it('omits the field entirely when no tool was declared', async () => {
    const { useCase, openai } = build();

    await useCase.execute(aCommand());

    expect(openai.calls[0]?.request.tools).toBeUndefined();
  });

  it('carries a previous turn back so the model can match result to call', async () => {
    const { useCase, openai } = build();

    await useCase.execute(
      aCommand({
        tools: [SEARCH_TOOL],
        messages: [
          { role: 'user', content: 'what does the handbook say' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'call_1', name: 'file_search', arguments: '{"query":"leave"}' }],
          },
          { role: 'tool', content: '30 days', toolCallId: 'call_1', name: 'file_search' },
        ],
      }),
    );

    const sent = openai.calls[0]?.request.messages ?? [];
    expect(sent[1]?.toolCalls?.[0]?.id).toBe('call_1');
    expect(sent[2]?.toolCallId).toBe('call_1');
  });
});

describe('tool calls coming back', () => {
  const CALLS = [{ id: 'call_1', name: 'file_search', arguments: '{"query":"leave"}' }];

  it('reports the calls and the finish reason on a non-streamed answer', async () => {
    const { useCase, openai } = build();
    openai.answerWithToolCalls(CALLS);

    const result = await useCase.execute(aCommand({ tools: [SEARCH_TOOL] }));

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual(CALLS);
  });

  it('reports them on the finished event of a stream', async () => {
    const { useCase, openai } = build();
    openai.answerWithToolCalls(CALLS);

    let finished: ChatCompletionResult | undefined;
    for await (const event of useCase.stream(aCommand({ tools: [SEARCH_TOOL], stream: true }))) {
      if (event.kind === 'finished') finished = event.result;
    }

    expect(finished?.finishReason).toBe('tool_calls');
    expect(finished?.toolCalls).toEqual(CALLS);
  });

  it('leaves the field absent when the model just answered', async () => {
    const { useCase } = build();

    const result = await useCase.execute(aCommand({ tools: [SEARCH_TOOL] }));

    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe('stop');
  });
});

/**
 * The cache is the dangerous interaction. It stores text keyed by the prompt, so
 * a primed entry would answer a tool-using turn with prose and the agent would
 * silently never make the call it was about to make.
 */
describe('the semantic cache and a tool-using turn', () => {
  it('is not even consulted when tools are declared', async () => {
    const { useCase, cache } = build();
    cache.primeWith({
      content: 'a stale answer',
      usage: { promptTokens: 1, completionTokens: 1 },
      deploymentId: 'openai-us',
    });

    const result = await useCase.execute(aCommand({ tools: [SEARCH_TOOL] }));

    expect(cache.lookups).toBe(0);
    expect(result.content).not.toBe('a stale answer');
    expect(result.routing.cacheHit).toBe(false);
  });

  it('stores nothing from a tool-using turn', async () => {
    const { useCase, cache } = build();

    await useCase.execute(aCommand({ tools: [SEARCH_TOOL] }));

    expect(cache.stored).toHaveLength(0);
  });

  it('still caches an ordinary turn', async () => {
    const { useCase, cache } = build();

    await useCase.execute(aCommand());

    expect(cache.lookups).toBe(1);
    expect(cache.stored).toHaveLength(1);
  });
});

/**
 * Streamed calls arrive as fragments. This is where a provider adapter is most
 * likely to be quietly wrong: two parallel calls interleave, and appending in
 * arrival order splices one call's JSON into the other's.
 */
describe('ToolCallAccumulator', () => {
  it('rejoins the arguments of a single call', () => {
    const accumulator = new ToolCallAccumulator();

    accumulator.add([{ index: 0, id: 'call_1', function: { name: 'file_search' } }]);
    accumulator.add([{ index: 0, function: { arguments: '{"que' } }]);
    accumulator.add([{ index: 0, function: { arguments: 'ry":"leave"}' } }]);

    expect(accumulator.drain()).toEqual([
      { id: 'call_1', name: 'file_search', arguments: '{"query":"leave"}' },
    ]);
  });

  it('keeps two interleaved calls apart', () => {
    const accumulator = new ToolCallAccumulator();

    accumulator.add([
      { index: 0, id: 'call_a', function: { name: 'search' } },
      { index: 1, id: 'call_b', function: { name: 'lookup' } },
    ]);
    accumulator.add([{ index: 1, function: { arguments: '{"id":' } }]);
    accumulator.add([{ index: 0, function: { arguments: '{"q":"x"}' } }]);
    accumulator.add([{ index: 1, function: { arguments: '7}' } }]);

    expect(accumulator.drain()).toEqual([
      { id: 'call_a', name: 'search', arguments: '{"q":"x"}' },
      { id: 'call_b', name: 'lookup', arguments: '{"id":7}' },
    ]);
  });

  it('is empty until a fragment names a call', () => {
    const accumulator = new ToolCallAccumulator();

    accumulator.add(undefined);

    expect(accumulator.isEmpty).toBe(true);
  });

  it('drops a call the provider never named', () => {
    const accumulator = new ToolCallAccumulator();

    accumulator.add([{ index: 0, function: { arguments: '{}' } }]);

    expect(accumulator.drain()).toEqual([]);
  });

  it('defaults missing arguments to an empty object, not an empty string', () => {
    const accumulator = new ToolCallAccumulator();

    accumulator.add([{ index: 0, id: 'call_1', function: { name: 'now' } }]);

    // `JSON.parse('')` throws; a tool taking no argument must not blow up the
    // caller that parses what the model wrote.
    expect(accumulator.drain()[0]?.arguments).toBe('{}');
  });
});

/**
 * Opaque provider state.
 *
 * Gemini returns a `thoughtSignature` beside every function call and answers
 * 400 on the next turn without it. The platform carries it and never reads it.
 */
describe('provider state travels with a tool call', () => {
  const WITH_STATE = [
    { id: 'call_1', name: 'file_search', arguments: '{}', providerState: 'opaque-signature' },
  ];

  it('comes back out on the result', async () => {
    const { useCase, openai } = build();
    openai.answerWithToolCalls(WITH_STATE);

    const result = await useCase.execute(aCommand({ tools: [SEARCH_TOOL] }));

    expect(result.toolCalls?.[0]?.providerState).toBe('opaque-signature');
  });

  it('goes back in on the next turn, unchanged', async () => {
    const { useCase, openai } = build();

    await useCase.execute(
      aCommand({
        tools: [SEARCH_TOOL],
        messages: [
          { role: 'user', content: 'what does the handbook say' },
          { role: 'assistant', content: null, toolCalls: WITH_STATE },
          { role: 'tool', content: '30 days', toolCallId: 'call_1', name: 'file_search' },
        ],
      }),
    );

    expect(openai.calls[0]?.request.messages[1]?.toolCalls?.[0]?.providerState).toBe(
      'opaque-signature',
    );
  });

  it('is absent for a provider that needs nothing echoed', async () => {
    const { useCase, openai } = build();
    openai.answerWithToolCalls([{ id: 'call_1', name: 'file_search', arguments: '{}' }]);

    const result = await useCase.execute(aCommand({ tools: [SEARCH_TOOL] }));

    // OpenAI and Anthropic reject an unknown field inside a tool call.
    expect(result.toolCalls?.[0]).not.toHaveProperty('providerState');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace, type Attributes } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AIA_ATTR, GEN_AI_ATTR } from '@aia/telemetry';

import { CreateChatCompletion } from '../src/modules/completions/application/use-cases/create-chat-completion.js';
import { DeploymentExecutor } from '../src/modules/completions/application/services/deployment-executor.js';
import type {
  CreateChatCompletionCommand,
  StreamEvent,
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
 * What a model call leaves behind in a trace.
 *
 * These assert on EXPORTED spans rather than on a spy, because the failure this
 * is guarding against is not "the wrong function was called" — it is an
 * attribute that never arrives. Every attribute below was already computed,
 * returned to the caller and written to the audit while reaching no span at
 * all, so the question "how much did project X spend on Gemini last week" could
 * be answered from a database and from nothing a trace query could reach.
 */

const OPENAI = aDeployment({
  id: 'openai-us',
  provider: 'openai',
  dataZone: 'us',
  priority: 0,
  inputCostPerMillion: 1_000_000n,
  outputCostPerMillion: 2_000_000n,
  maxOutputTokens: 1000,
});

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

function build(): { useCase: CreateChatCompletion; ledger: FakeBudgetLedger } {
  const ledger = new FakeBudgetLedger();
  const openai = new FakeModelProvider('openai');
  const useCase = new CreateChatCompletion(
    new FakePolicyReader(),
    new FakeAliasRegistry([anAlias([OPENAI])]),
    ledger,
    new FakeGuardrail(),
    new FakeSemanticCache(),
    new WordTokenEstimator(),
    new FakeAuditRepository(),
    new FakeUsagePublisher(),
    new FixedClock(),
    new CountingBulkhead(),
    // The executor is constructed AFTER `provider.register()`, because it takes
    // its tracer once. One built earlier holds a tracer from the previous
    // provider and exports into a test that has already finished.
    new DeploymentExecutor([openai]),
  );
  return { useCase, ledger };
}

function aCommand(
  overrides: Partial<CreateChatCompletionCommand> = {},
): CreateChatCompletionCommand {
  return {
    requestId: 'req-1',
    projectId: 'proj-1',
    principalId: 'user-ana',
    alias: 'chat-fast',
    messages: [{ role: 'user', content: 'hello how are you' }],
    stream: false,
    ...overrides,
  };
}

/** Runs the use case inside a span, the way an HTTP request does in production. */
async function underAServerSpan(run: () => Promise<unknown>): Promise<void> {
  const tracer = trace.getTracer('test');
  await tracer.startActiveSpan('POST /v1/chat/completions', async (span) => {
    try {
      await run();
    } finally {
      span.end();
    }
  });
}

function attributesOf(name: string): Attributes {
  const span = exporter.getFinishedSpans().find((candidate) => candidate.name.startsWith(name));
  const names = exporter
    .getFinishedSpans()
    .map((candidate) => candidate.name)
    .join(', ');
  expect(span, `no span named ${name}; the trace holds: ${names}`).toBeDefined();
  return span?.attributes ?? {};
}

describe('the model call span', () => {
  it('carries the tenant, like every other span', async () => {
    const { useCase } = build();
    await underAServerSpan(() => useCase.execute(aCommand()));

    // ADR-009. Without it this span — the only one that knows what a call cost —
    // is invisible to every tenant-scoped trace query.
    expect(attributesOf('chat')[AIA_ATTR.PROJECT_ID]).toBe('proj-1');
    expect(attributesOf('chat')[AIA_ATTR.PRINCIPAL_ID]).toBe('user-ana');
    expect(attributesOf('chat')[AIA_ATTR.ALIAS]).toBe('chat-fast');
  });

  it('names the provider under both the old convention and the new', async () => {
    const { useCase } = build();
    await underAServerSpan(() => useCase.execute(aCommand()));

    // The GenAI conventions renamed `gen_ai.system` to `gen_ai.provider.name`.
    // Emitting only the new one empties every dashboard built on the old, and
    // emitting only the old one is invisible to a backend's own GenAI view.
    expect(attributesOf('chat')[GEN_AI_ATTR.SYSTEM]).toBe('openai');
    expect(attributesOf('chat')[GEN_AI_ATTR.PROVIDER_NAME]).toBe('openai');
  });

  it('carries the classification the routing decision was made on', async () => {
    const { useCase } = build();
    await underAServerSpan(() => useCase.execute(aCommand()));

    // ADR-010 routes on this. A trace that shows the zone but not the
    // classification shows the decision without its reason.
    expect(attributesOf('chat')[AIA_ATTR.DATA_CLASSIFICATION]).toBeDefined();
    expect(attributesOf('chat')[AIA_ATTR.DATA_ZONE]).toBe('us');
  });
});

describe('what the platform decided about the request', () => {
  it('records the flags the response carries, on the request span', async () => {
    const { useCase } = build();
    await underAServerSpan(() => useCase.execute(aCommand()));

    const request = attributesOf('POST /v1/chat/completions');
    // `false` is an answer and has to be recorded as one: a rate of degraded
    // requests needs the denominator, and an attribute only set when something
    // went wrong cannot provide it.
    expect(request[AIA_ATTR.CACHE_HIT]).toBe(false);
    expect(request[AIA_ATTR.POLICY_STALE]).toBe(false);
    expect(request[AIA_ATTR.BUDGET_UNVERIFIED]).toBe(false);
    expect(request[AIA_ATTR.GUARDRAILS_UNVERIFIED]).toBe(false);
  });

  it('records what was reserved and what was actually committed', async () => {
    const { useCase } = build();
    await underAServerSpan(() => useCase.execute(aCommand()));

    const request = attributesOf('POST /v1/chat/completions');
    // The estimate is the output ceiling; the commitment is what the tokens
    // really cost. The GAP between them is the whole point of recording both:
    // it says how much of a project's balance this platform holds hostage
    // against calls that never spend it.
    expect(request[AIA_ATTR.BUDGET_RESERVED_MICROS]).toBe(4 + 2000);
    expect(request[AIA_ATTR.BUDGET_COMMITTED_MICROS]).toBe(100 + 100);
  });
});

describe('the span of a STREAMED call', () => {
  async function drain(stream: AsyncGenerator<StreamEvent>): Promise<void> {
    // The tokens themselves are asserted elsewhere; this is about the span.
    for await (const event of stream) void event;
  }

  it('stays open until the generation finishes, not until the first token', async () => {
    const { useCase } = build();
    await underAServerSpan(() => drain(useCase.stream(aCommand({ stream: true }))));

    const model = attributesOf('chat');
    // A span that ended at the first token could not carry these: the token
    // counts are only known when the provider closes the stream. Their
    // presence IS the proof that the span covered the generation.
    expect(model[GEN_AI_ATTR.USAGE_INPUT_TOKENS]).toBe(100);
    expect(model[GEN_AI_ATTR.USAGE_OUTPUT_TOKENS]).toBe(50);
    expect(model[GEN_AI_ATTR.RESPONSE_FINISH_REASONS]).toEqual(['stop']);
  });

  it('ends the span even when the caller walks away mid-stream', async () => {
    const { useCase } = build();

    await underAServerSpan(async () => {
      // A client hanging up. The generator's `return()` runs, and nothing else.
      for await (const event of useCase.stream(aCommand({ stream: true }))) {
        void event;
        break;
      }
    });

    // An unfinished span is never exported, so a leak here shows up as an
    // absence -- and interrupted answers are exactly the ones worth looking at.
    const names = exporter.getFinishedSpans().map((candidate) => candidate.name);
    expect(names.some((name) => name.startsWith('chat'))).toBe(true);
  });

  it('carries the tenant on a streamed call too', async () => {
    const { useCase } = build();
    await underAServerSpan(() => drain(useCase.stream(aCommand({ stream: true }))));

    expect(attributesOf('chat')[AIA_ATTR.PROJECT_ID]).toBe('proj-1');
  });
});

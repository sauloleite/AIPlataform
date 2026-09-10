import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { metrics, type Attributes } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { AIA_ATTR, AIA_METRIC, resetInstruments } from '@aia/telemetry';

import { CreateChatCompletion } from '../src/modules/completions/application/use-cases/create-chat-completion.js';
import { DeploymentExecutor } from '../src/modules/completions/application/services/deployment-executor.js';
import { BudgetExhaustedError } from '../src/modules/completions/domain/errors/index.js';
import type { CreateChatCompletionCommand } from '../src/modules/completions/application/dto.js';
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
 * The six metrics reference doc 02 §11 asks for.
 *
 * All six names were declared and no instrument was ever created, so the SLO
 * dashboards the production checklist requires could not exist. These assert on
 * what an exporter RECEIVES: a test that checked a function was called would
 * pass just as happily against a meter wired to nothing, which is the exact
 * state this is meant to leave behind.
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

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

beforeEach(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
  });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  // The instruments are cached after their first use, so a suite that did not
  // drop them would keep recording into the provider of whichever test ran
  // first — and every assertion after it would read an empty exporter.
  resetInstruments();
});

afterEach(async () => {
  await provider.shutdown();
  metrics.disable();
  resetInstruments();
});

function build(options: { limitMicros?: bigint } = {}): CreateChatCompletion {
  return new CreateChatCompletion(
    new FakePolicyReader(
      options.limitMicros === undefined ? {} : { limitMicros: options.limitMicros },
    ),
    new FakeAliasRegistry([anAlias([OPENAI])]),
    new FakeBudgetLedger(),
    new FakeGuardrail(),
    new FakeSemanticCache(),
    new WordTokenEstimator(),
    new FakeAuditRepository(),
    new FakeUsagePublisher(),
    new FixedClock(),
    new CountingBulkhead(),
    new DeploymentExecutor([new FakeModelProvider('openai')]),
  );
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

/** Forces a collection and returns every point the exporter received. */
async function collected(): Promise<ResourceMetrics[]> {
  await provider.forceFlush();
  return exporter.getMetrics();
}

/**
 * Every data point recorded under one metric name.
 *
 * The return type is deliberately loose: a counter yields points whose value is
 * a number and a histogram yields points whose value is a bucketed record, and
 * a signature naming both unions cannot accept either of the SDK's own arrays.
 * These are assertions about labels and totals, not about the SDK's shapes.
 */
async function pointsOf(name: string): Promise<{ attributes: Attributes; value: unknown }[]> {
  const all = await collected();
  const points: { attributes: Attributes; value: unknown }[] = [];
  for (const resource of all) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name === name) points.push(...metric.dataPoints);
      }
    }
  }
  return points;
}

describe('what a call measures', () => {
  it('records the duration, with the project it belongs to', async () => {
    await build().execute(aCommand());

    const points = await pointsOf(AIA_METRIC.INFERENCE_DURATION);
    expect(points).toHaveLength(1);
    // The project label is what makes cost-per-project answerable at all.
    expect(points[0]?.attributes[AIA_ATTR.PROJECT_ID]).toBe('proj-1');
    expect(points[0]?.attributes[AIA_ATTR.ALIAS]).toBe('chat-fast');
  });

  it('counts input and output tokens as separate series', async () => {
    await build().execute(aCommand());

    const points = await pointsOf(AIA_METRIC.TOKENS_USED);
    const byType = Object.fromEntries(
      points.map((point) => [point.attributes['gen_ai.token.type'], point.value]),
    );
    // They cost different amounts, and a rise in one means something quite
    // different from a rise in the other. Summed, neither is recoverable.
    expect(byType).toEqual({ input: 100, output: 50 });
  });

  it('counts the cost in micros, which is what showback is built on', async () => {
    await build().execute(aCommand());

    const points = await pointsOf(AIA_METRIC.COST_MICROS);
    expect(points[0]?.value).toBe(200);
  });

  it('does not record a time to first token for a call that has no such moment', async () => {
    await build().execute(aCommand());

    // A blocking call arrives all at once. Recording a zero would pull the
    // whole p95 down and quietly make the SLO look met.
    expect(await pointsOf(AIA_METRIC.TIME_TO_FIRST_TOKEN)).toHaveLength(0);
  });

  it('records a time to first token for a streamed one', async () => {
    const useCase = build();
    for await (const event of useCase.stream(aCommand({ stream: true }))) void event;

    expect(await pointsOf(AIA_METRIC.TIME_TO_FIRST_TOKEN)).toHaveLength(1);
  });
});

describe('a refusal on budget', () => {
  it('is counted apart from the failures', async () => {
    // A limit the estimate cannot fit under, which is how the ledger refuses.
    await expect(build({ limitMicros: 10n }).execute(aCommand())).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );

    const points = await pointsOf(AIA_METRIC.BUDGET_REJECTIONS);
    // A rising rejection rate is a conversation with a customer; a rising error
    // rate is an incident. A dashboard that mixes them tells you neither.
    expect(points[0]?.value).toBe(1);
    expect(points[0]?.attributes[AIA_ATTR.PROJECT_ID]).toBe('proj-1');
  });

  it('records no duration, because nothing ran', async () => {
    await expect(build({ limitMicros: 10n }).execute(aCommand())).rejects.toThrow();

    expect(await pointsOf(AIA_METRIC.INFERENCE_DURATION)).toHaveLength(0);
  });
});

describe('a circuit opening', () => {
  // Thirty seconds, and slow on purpose. The retry backoff is a real sleep and
  // tripping a five-failure breaker means waiting through several of them; the
  // obvious alternative, fake timers, stalls the metric reader's own flush and
  // the test times out waiting for numbers that never arrive.
  const TRIPPING_A_BREAKER_TAKES_A_WHILE = 30_000;

  it(
    'is counted, by deployment and by transition',
    async () => {
      const provider = new FakeModelProvider('openai');
      // Comfortably past the five failures the inference policy opens on,
      // counting the retries each call makes.
      provider.failNext(new Error('provider down'), 50);
      const executor = new DeploymentExecutor([provider]);

      for (let call = 0; call < 4; call += 1) {
        await executor
          .chat(
            { messages: [], maxOutputTokens: 8 },
            [OPENAI],
            { stream: false },
            {
              projectId: 'proj-1',
            },
          )
          .catch(() => undefined);
      }

      const points = await pointsOf(AIA_METRIC.CIRCUIT_STATE_CHANGES);
      expect(points.length).toBeGreaterThan(0);
      // Doc 02 §11 asks for circuit state as an SLI. A line in a log is not
      // one: nothing can chart it and no alert can fire on it.
      expect(points[0]?.attributes[AIA_ATTR.DEPLOYMENT_ID]).toBe('openai-us');
      expect(points[0]?.attributes['aia.circuit.to']).toBe('open');
    },
    TRIPPING_A_BREAKER_TAKES_A_WHILE,
  );
});

import { beforeEach, describe, expect, it } from 'vitest';
import { CreateChatCompletion } from '../src/modules/completions/application/use-cases/create-chat-completion.js';
import { DeploymentExecutor } from '../src/modules/completions/application/services/deployment-executor.js';
import {
  AliasNotFoundError,
  BudgetExhaustedError,
  GuardrailBlockedError,
  NoCompatibleDeploymentError,
  PromptInjectionSuspectedError,
} from '../src/modules/completions/domain/errors/index.js';
import type { CreateChatCompletionCommand } from '../src/modules/completions/application/dto.js';
import type { StreamEvent } from '../src/modules/completions/application/dto.js';
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
 * Flow 7.1 from reference doc 02, exercised with fakes.
 *
 * No network, no containers: the use case talks only to ports, so the error
 * paths — blown budget, incompatible zone, interrupted stream — can be tested
 * deterministically.
 */

const LOCAL = aDeployment({
  id: 'ollama-local',
  provider: 'ollama',
  dataZone: 'local',
  priority: 1,
});

const OPENAI = aDeployment({
  id: 'openai-us',
  provider: 'openai',
  dataZone: 'us',
  priority: 0,
  // 1.00 per million input tokens, 2.00 per million output tokens.
  inputCostPerMillion: 1_000_000n,
  outputCostPerMillion: 2_000_000n,
  maxOutputTokens: 1000,
});

interface Harness {
  useCase: CreateChatCompletion;
  bulkhead: CountingBulkhead;
  ledger: FakeBudgetLedger;
  policies: FakePolicyReader;
  audit: FakeAuditRepository;
  usage: FakeUsagePublisher;
  guardrail: FakeGuardrail;
  cache: FakeSemanticCache;
  openai: FakeModelProvider;
  ollama: FakeModelProvider;
}

function build(
  options: {
    policy?: ConstructorParameters<typeof FakePolicyReader>[0];
    snapshot?: ConstructorParameters<typeof FakePolicyReader>[1];
    deployments?: (typeof LOCAL)[];
  } = {},
): Harness {
  const ledger = new FakeBudgetLedger();
  const policies = new FakePolicyReader(options.policy, options.snapshot);
  const audit = new FakeAuditRepository();
  const usage = new FakeUsagePublisher();
  const guardrail = new FakeGuardrail();
  const cache = new FakeSemanticCache();
  const openai = new FakeModelProvider('openai');
  const ollama = new FakeModelProvider('ollama');

  const alias = anAlias(options.deployments ?? [OPENAI, LOCAL]);
  const executor = new DeploymentExecutor([openai, ollama]);

  const bulkhead = new CountingBulkhead();
  const useCase = new CreateChatCompletion(
    policies,
    new FakeAliasRegistry([alias]),
    ledger,
    guardrail,
    cache,
    new WordTokenEstimator(),
    audit,
    usage,
    new FixedClock(),
    bulkhead,
    executor,
  );

  return { useCase, bulkhead, ledger, policies, audit, usage, guardrail, cache, openai, ollama };
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

describe('CreateChatCompletion - happy path', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = build();
  });

  it('serves from the highest-priority compatible deployment', async () => {
    const result = await harness.useCase.execute(aCommand());

    expect(result.content).toBe('deterministic answer');
    expect(result.routing.deploymentId).toBe('openai-us');
    expect(result.routing.provider).toBe('openai');
    expect(result.routing.attempts).toBe(1);
  });

  it('reserves before calling and commits the REAL cost afterwards', async () => {
    await harness.useCase.execute(aCommand());

    // Estimate: 4 prompt words plus the 1000-token output ceiling.
    const reserved = harness.ledger.reserved[0];
    expect(reserved?.estimated.micros).toBe(4n + 2000n);

    // Real: 100 input tokens (0.0001) plus 50 output tokens (0.0001).
    const committed = harness.ledger.committed[0];
    expect(committed?.actual.micros).toBe(100n + 100n);
    expect(harness.ledger.released).toHaveLength(0);
  });

  it('records audit with the data zone, which is the residency evidence', async () => {
    await harness.useCase.execute(aCommand());

    expect(harness.audit.last()).toMatchObject({
      requestId: 'req-1',
      projectId: 'proj-1',
      principalId: 'user-ana',
      deploymentId: 'openai-us',
      dataZone: 'us',
      status: 'completed',
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it('publishes UsageRecorded with cost, zone and classification', async () => {
    await harness.useCase.execute(aCommand());

    expect(harness.usage.last()).toMatchObject({
      alias: 'chat-fast',
      provider: 'openai',
      dataZone: 'us',
      dataClassification: 'internal',
      status: 'completed',
      budgetUnverified: false,
      policyStale: false,
    });
  });

  it('stores no content when the project did not opt into capture', async () => {
    await harness.useCase.execute(aCommand());

    expect(harness.audit.last()?.redactedPrompt).toBeUndefined();
    expect(harness.audit.last()?.redactedCompletion).toBeUndefined();
  });

  it('stores redacted content when the project opts into capture', async () => {
    const withCapture = build({ policy: { contentCapture: true } });
    withCapture.guardrail.respondWith({ text: 'my id is <BR_CPF>', redactedCount: 1 });

    await withCapture.useCase.execute(
      aCommand({ messages: [{ role: 'user', content: 'my id is 111.444.777-35' }] }),
    );

    const record = withCapture.audit.last();
    expect(record?.redactedPrompt).toBe('my id is <BR_CPF>');
    // The original value never reaches persistence.
    expect(record?.redactedPrompt).not.toContain('111.444.777-35');
  });
});

describe('CreateChatCompletion - routing by data classification (ADR-010)', () => {
  it('a restricted project is served by the local model, not the cheapest one', async () => {
    const harness = build({
      policy: {},
      snapshot: { classification: 'restricted', allowedZones: ['local'] },
    });

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.deploymentId).toBe('ollama-local');
    expect(result.routing.dataZone).toBe('local');
    // The external provider was never even called.
    expect(harness.openai.calls).toHaveLength(0);
  });

  it('refuses when no compatible destination exists, instead of sending anyway', async () => {
    const harness = build({
      deployments: [OPENAI],
      snapshot: { classification: 'restricted', allowedZones: ['local'] },
    });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(
      NoCompatibleDeploymentError,
    );
    expect(harness.openai.calls).toHaveLength(0);
    // Nothing was reserved: the refusal happens before touching the budget.
    expect(harness.ledger.reserved).toHaveLength(0);
  });

  it('rejects a nonexistent alias', async () => {
    const harness = build();
    await expect(
      harness.useCase.execute(aCommand({ alias: 'does-not-exist' })),
    ).rejects.toBeInstanceOf(AliasNotFoundError);
  });
});

describe('CreateChatCompletion - budget', () => {
  it('refuses with 429 when the reservation does not fit the limit', async () => {
    const harness = build({ policy: { limitMicros: 10n } });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(harness.openai.calls).toHaveLength(0);
  });

  it('a project that does not block at its limit keeps being served', async () => {
    const harness = build({ policy: { limitMicros: 1n, blockAtLimit: false } });
    await expect(harness.useCase.execute(aCommand())).resolves.toMatchObject({
      content: 'deterministic answer',
    });
  });

  it('releases the reservation when the provider call fails (saga compensation)', async () => {
    const harness = build();
    harness.openai.failNext(new Error('provider down'), 5);
    harness.ollama.failNext(new Error('local down'), 5);

    await expect(harness.useCase.execute(aCommand())).rejects.toThrow();

    expect(harness.ledger.released).toHaveLength(1);
    expect(harness.ledger.committed).toHaveLength(0);
    // The failure becomes evidence: audit and event are emitted even without success.
    expect(harness.audit.last()?.status).toBe('failed');
    expect(harness.usage.last()?.status).toBe('failed');
  });

  it('without Redis, serves and flags budget_unverified instead of failing', async () => {
    const harness = build();
    harness.ledger.goDown();

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.budgetUnverified).toBe(true);
    expect(result.content).toBe('deterministic answer');
    expect(harness.ledger.reserved).toHaveLength(0);
    expect(harness.usage.last()?.budgetUnverified).toBe(true);
  });
});

describe('CreateChatCompletion - governance degradation', () => {
  it('responds with policy_stale when the policy comes from cache', async () => {
    const harness = build();
    harness.policies.goStale();

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.policyStale).toBe(true);
    expect(harness.usage.last()?.policyStale).toBe(true);
  });
});

describe('CreateChatCompletion - failover across deployments', () => {
  it('falls through to the next deployment when the first fails', async () => {
    const harness = build();
    harness.openai.failNext(new Error('502 bad gateway'), 5);

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.deploymentId).toBe('ollama-local');
    expect(result.routing.attempts).toBe(2);
  });

  it('charges the cost of the deployment that ACTUALLY served', async () => {
    const harness = build();
    harness.openai.failNext(new Error('502'), 5);

    await harness.useCase.execute(aCommand());

    // Ollama is local and costs zero, even though the reservation used OpenAI's price.
    expect(harness.ledger.committed[0]?.actual.micros).toBe(0n);
  });
});

describe('CreateChatCompletion - guardrails (OWASP LLM01 and LLM02)', () => {
  it('sends the provider the already redacted text, never the original', async () => {
    const harness = build();
    harness.guardrail.respondWith({ text: 'my id is <BR_CPF>', redactedCount: 1 });

    await harness.useCase.execute(
      aCommand({ messages: [{ role: 'user', content: 'my id is 111.444.777-35' }] }),
    );

    const sent = harness.openai.calls[0]?.request.messages[0]?.content;
    expect(sent).toBe('my id is <BR_CPF>');
  });

  it('blocks when the guardrail decides to block', async () => {
    const harness = build();
    harness.guardrail.respondWith({ decision: 'block' });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(harness.openai.calls).toHaveLength(0);
  });

  it('rejects a prompt with a strong injection signal', async () => {
    const harness = build();
    harness.guardrail.respondWith({
      injectionSuspected: true,
      injectionScore: 0.95,
      injectionSignals: ['ignore_previous_instructions'],
    });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(
      PromptInjectionSuspectedError,
    );
  });

  it('a weak injection signal does not block: the threshold exists to avoid false positives', async () => {
    const harness = build();
    harness.guardrail.respondWith({ injectionSuspected: true, injectionScore: 0.4 });

    await expect(harness.useCase.execute(aCommand())).resolves.toMatchObject({
      content: 'deterministic answer',
    });
  });

  it('an unavailable guardrail does not break inference', async () => {
    const harness = build();
    harness.guardrail.available = false;

    await expect(harness.useCase.execute(aCommand())).resolves.toBeDefined();
    expect(harness.guardrail.inspected).toHaveLength(0);
  });
});

describe('CreateChatCompletion - cache', () => {
  it('a cache hit calls no provider and consumes no budget', async () => {
    const harness = build();
    harness.cache.primeWith({
      content: 'from cache',
      usage: { promptTokens: 10, completionTokens: 5 },
      deploymentId: 'openai-us',
    });

    const result = await harness.useCase.execute(aCommand());

    expect(result.content).toBe('from cache');
    expect(result.routing.cacheHit).toBe(true);
    expect(result.routing.cost.micros).toBe(0n);
    expect(harness.openai.calls).toHaveLength(0);
    expect(harness.ledger.reserved).toHaveLength(0);
  });

  it('stores the answer in cache after a real call', async () => {
    const harness = build();
    await harness.useCase.execute(aCommand());
    expect(harness.cache.stored[0]?.content).toBe('deterministic answer');
  });
});

describe('CreateChatCompletion - streaming', () => {
  async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it('emits deltas and ends with the complete result', async () => {
    const harness = build();
    const events = await collect(harness.useCase.stream(aCommand({ stream: true })));

    const deltas = events.filter((event) => event.kind === 'delta');
    expect(deltas.map((event) => event.content).join('')).toBe('deterministic answer');

    const finished = events.at(-1);
    expect(finished?.kind).toBe('finished');
    if (finished?.kind === 'finished') {
      expect(finished.result.content).toBe('deterministic answer');
      expect(finished.result.usage.totalTokens).toBe(150);
    }
  });

  it('commits the real usage reported in the last chunk', async () => {
    const harness = build();
    await collect(harness.useCase.stream(aCommand({ stream: true })));

    expect(harness.ledger.committed[0]?.actual.micros).toBe(200n);
  });

  it('an interrupted stream commits the partial usage and marks the event partial', async () => {
    const harness = build();
    harness.openai.breakStreamAfter(1);

    const events = await collect(harness.useCase.stream(aCommand({ stream: true })));

    // The client received content: there is no way to retry without duplicating.
    expect(events.some((event) => event.kind === 'delta')).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'stream_interrupted' });

    expect(harness.ledger.committed).toHaveLength(1);
    expect(harness.ledger.released).toHaveLength(0);
    expect(harness.usage.last()?.status).toBe('partial');
    expect(harness.usage.last()?.errorCode).toBe('stream_interrupted');
  });

  it('a failure BEFORE the first token releases the reservation and propagates', async () => {
    const harness = build();
    harness.openai.failNext(new Error('502'), 5);
    harness.ollama.failNext(new Error('502'), 5);

    await expect(collect(harness.useCase.stream(aCommand({ stream: true })))).rejects.toThrow();

    expect(harness.ledger.released).toHaveLength(1);
    expect(harness.ledger.committed).toHaveLength(0);
  });

  it('records time to first token, which is the router SLI', async () => {
    const harness = build();
    await collect(harness.useCase.stream(aCommand({ stream: true })));

    expect(harness.usage.last()?.timeToFirstTokenMs).toBeDefined();
  });
});

/**
 * Admission control (OWASP LLM10, unbounded consumption).
 *
 * Five pieces of this existed before any of them met: the policy declared a
 * bulkhead, the library implemented two, the executor supported one,
 * `Project.maxConcurrentRequests` was carried all the way from governance into
 * the router, and `concurrency_limit` was in the error catalogue and already
 * rendered by the console. Nothing ever took a slot.
 */
describe('concurrency limit per project', () => {
  it('refuses with concurrency_limit once the project is at its ceiling', async () => {
    const { useCase, bulkhead } = build({ policy: { maxConcurrentRequests: 1 } });

    // One slot taken outside the use case, standing in for a request already
    // in flight on this or on another replica.
    await bulkhead.acquire('proj-1', 1);

    await expect(useCase.execute(aCommand())).rejects.toMatchObject({
      code: 'concurrency_limit',
      status: 429,
    });
  });

  it('reserves no budget for a request it refuses', async () => {
    const { useCase, bulkhead, ledger } = build({ policy: { maxConcurrentRequests: 1 } });
    await bulkhead.acquire('proj-1', 1);

    await useCase.execute(aCommand()).catch(() => undefined);

    // Money reserved for an answer nobody receives has to be released again,
    // and the cheapest way to get that right is never to reserve it.
    expect(ledger.reserved).toHaveLength(0);
  });

  it('uses the project policy as the ceiling, not the library default', async () => {
    const { useCase, bulkhead } = build({ policy: { maxConcurrentRequests: 3 } });

    await useCase.execute(aCommand());

    // 20 is what POLICIES.INFERENCE declares. The number that governs is the
    // one governance set, which is the whole reason `acquire` takes it.
    expect(bulkhead.acquired[0]).toEqual({ key: 'proj-1', limit: 3 });
  });

  it('releases the slot when the provider fails', async () => {
    const { useCase, bulkhead, openai } = build({ deployments: [OPENAI] });
    openai.failNext(new Error('provider down'), 5);

    await useCase.execute(aCommand()).catch(() => undefined);

    // A failure that leaked a slot would shrink the project's capacity by one
    // for the lease TTL, and a provider outage would look like a concurrency
    // problem an hour later.
    expect(bulkhead.inFlightFor('proj-1')).toBe(0);
  });

  it('releases the slot when the answer succeeds', async () => {
    const { useCase, bulkhead } = build();

    await useCase.execute(aCommand());

    expect(bulkhead.inFlightFor('proj-1')).toBe(0);
  });

  it('releases the slot at the end of a stream', async () => {
    const { useCase, bulkhead } = build();

    // Drained to the end, which is what a client that reads the whole answer
    // does and what makes the generator's `finally` run.
    const events = [];
    for await (const event of useCase.stream(aCommand({ stream: true }))) events.push(event);
    expect(events.length).toBeGreaterThan(0);

    expect(bulkhead.inFlightFor('proj-1')).toBe(0);
  });

  it('releases the slot when the client abandons the stream half way', async () => {
    const { useCase, bulkhead } = build();

    const stream = useCase.stream(aCommand({ stream: true }));
    await stream.next();
    await stream.return(undefined);

    // A disconnected browser is the common case, not the exotic one.
    expect(bulkhead.inFlightFor('proj-1')).toBe(0);
  });

  it('serves a cached answer without taking a slot at all', async () => {
    const { useCase, bulkhead, cache } = build({ policy: { maxConcurrentRequests: 1 } });
    cache.primeWith({
      content: 'from the cache',
      usage: { promptTokens: 1, completionTokens: 1 },
      deploymentId: 'openai-us',
    });
    await bulkhead.acquire('proj-1', 1);

    const result = await useCase.execute(aCommand());

    // Refusing an answer already in Redis would make the platform least
    // available exactly when the cache is doing the most good.
    expect(result.content).toBe('from the cache');
    expect(bulkhead.acquired).toHaveLength(1);
  });
});

/**
 * Degrading loudly instead of quietly.
 *
 * `HttpGuardrail` catches every error and returns `decision: 'allow'` with the
 * original text, logging a warning. The content still reaches the provider,
 * unredacted, and the caller was never told: an `allow` from a working
 * guardrail and an `allow` from an unreachable one were the same value.
 *
 * Compare Redis, which already had this right: an unavailable budget ledger
 * degrades to `budget_unverified`, the response carries it and the console
 * renders it.
 */
describe('when the guardrail cannot inspect the content', () => {
  it('answers, and says the content was not inspected', async () => {
    const { useCase, guardrail } = build();
    guardrail.goDown();

    const result = await useCase.execute(aCommand());

    // Failing open is the right default: refusing every request because a
    // guardrail is down trades a risk for an outage.
    expect(result.content).not.toBe('');
    expect(result.routing.guardrailsUnverified).toBe(true);
  });

  it('says so when no guardrail is deployed at all', async () => {
    const { useCase, guardrail } = build();
    guardrail.available = false;

    const result = await useCase.execute(aCommand());

    // Switched off by configuration rather than broken, and the answer the
    // caller needs is the same: this content was not inspected.
    expect(result.routing.guardrailsUnverified).toBe(true);
  });

  it('reports a working guardrail as verified', async () => {
    const { useCase } = build();

    const result = await useCase.execute(aCommand());

    expect(result.routing.guardrailsUnverified).toBe(false);
  });

  it('refuses a RESTRICTED project rather than sending it unredacted', async () => {
    const { useCase, guardrail } = build({ snapshot: { classification: 'restricted' } });
    guardrail.goDown();

    // The classification exists to say the fail-open trade is not available
    // here: a project whose promise is that its data never leaves unredacted
    // cannot keep that promise with the redactor unreachable (ADR-026).
    await expect(useCase.execute(aCommand())).rejects.toMatchObject({
      code: 'guardrail_unavailable',
      status: 503,
    });
  });

  it('refuses a restricted project when no guardrail is deployed', async () => {
    const { useCase, guardrail } = build({ snapshot: { classification: 'restricted' } });
    guardrail.available = false;

    await expect(useCase.execute(aCommand())).rejects.toMatchObject({
      code: 'guardrail_unavailable',
    });
  });

  it('still serves a restricted project while the guardrail works', async () => {
    const { useCase } = build({ snapshot: { classification: 'restricted' } });

    const result = await useCase.execute(aCommand());

    // The refusal is about the guardrail being down, not about the
    // classification: restricted projects are the point of the platform.
    expect(result.routing.guardrailsUnverified).toBe(false);
  });

  it('carries the fact into the audit record and the usage event', async () => {
    const { useCase, guardrail, audit, usage } = build();
    guardrail.goDown();

    await useCase.execute(aCommand());

    // Residency evidence has to record that a control was not working, or the
    // record says the call was inspected when it was not.
    expect(audit.records[0]).toMatchObject({ guardrailsUnverified: true });
    expect(usage.published[0]).toMatchObject({ guardrailsUnverified: true });
  });
});

/**
 * Retention as a project decision (reference doc 02 §10.2, LGPD).
 *
 * It was `AUDIT_RETENTION_DAYS`, an environment variable per service, so every
 * project in a deployment kept its content for exactly as long as every other
 * -- and the LGPD procedure had no per-project handle to act on.
 */
describe('how long an audit record lives', () => {
  it('expires according to the project policy, not a deployment setting', async () => {
    const { useCase, audit } = build({ policy: { contentRetentionDays: 30 } });

    await useCase.execute(aCommand());

    const record = audit.records[0];
    const days = (record!.expiresAt.getTime() - record!.occurredAt.getTime()) / 86_400_000;
    expect(days).toBe(30);
  });

  it('gives two projects two different lifetimes', async () => {
    const short = build({ policy: { contentRetentionDays: 7 } });
    const long = build({ policy: { contentRetentionDays: 365 } });

    await short.useCase.execute(aCommand());
    await long.useCase.execute(aCommand());

    // The reason expiry moved onto the document: one collection-wide TTL index
    // holds one number and cannot answer both.
    const daysOf = (h: typeof short) => {
      const r = h.audit.records[0]!;
      return (r.expiresAt.getTime() - r.occurredAt.getTime()) / 86_400_000;
    };
    expect(daysOf(short)).toBe(7);
    expect(daysOf(long)).toBe(365);
  });

  it('still sets an expiry on a record with no content in it', async () => {
    const { useCase, audit } = build({ policy: { contentCapture: false } });

    await useCase.execute(aCommand());

    // The record itself carries principal_id and cost, which are personal data
    // whether or not the prompt was stored.
    expect(audit.records[0]?.expiresAt).toBeInstanceOf(Date);
  });
});

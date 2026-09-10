import { Inject, Injectable } from '@nestjs/common';
import type { Bulkhead, BulkheadLease } from '@aia/resilience';
import {
  annotateOutcome,
  recordBudgetRejection,
  recordInference,
  type BusinessContext,
} from '@aia/telemetry';
import {
  AliasNotFoundError,
  BudgetExhaustedError,
  GuardrailUnavailableError,
  StreamInterruptedError,
} from '../../domain/errors/index.js';
import { BudgetReservation } from '../../domain/entities/budget-reservation.js';
import { ModelSelectionPolicy } from '../../domain/services/model-selection-policy.js';
import { Cost } from '../../domain/value-objects/index.js';
import type { DataClassification } from '../../domain/value-objects/index.js';
import type { Deployment } from '../../domain/entities/deployment.js';
import type { UsageRecorded, UsageStatus } from '../../domain/events/usage-recorded.js';
import {
  ALIAS_REGISTRY,
  AUDIT_REPOSITORY,
  BUDGET_LEDGER,
  BULKHEAD,
  CLOCK,
  GUARDRAIL,
  POLICY_READER,
  SEMANTIC_CACHE,
  TOKEN_ESTIMATOR,
  USAGE_PUBLISHER,
  type AliasRegistry,
  type AuditRepository,
  type BudgetLedger,
  type ChatChunk,
  type ChatRequestInput,
  type Clock,
  type Guardrail,
  type PolicyReader,
  type PolicyResult,
  type SemanticCache,
  type TokenEstimator,
  type TokenUsage,
  type ToolCallOutput,
  type UsagePublisher,
} from '../ports.js';
import { DeploymentExecutor } from '../services/deployment-executor.js';
import {
  BlockOnDecisionStage,
  GuardrailPipeline,
  RejectInjectionStage,
} from '../guardrails/pipeline.js';
import type {
  ChatCompletionResult,
  CreateChatCompletionCommand,
  RoutingInfo,
  StreamEvent,
} from '../dto.js';

/**
 * Flow 7.1 from reference doc 02: chat with budget reserve and commit.
 *
 * The stage order, and why each one is there:
 *   1. project policy        -> defines zones, limits and budget
 *   2. guardrails on prompt  -> redacts PII BEFORE it leaves the platform
 *   3. deployment selection  -> ADR-010, sensitive data stays in its zone
 *   4. semantic cache        -> a repeated answer costs neither call nor token
 *   5. budget reservation    -> stops N calls from spending the same balance
 *   6. provider call         -> with failover across compatible deployments
 *   7. commit or compensate  -> saga: whatever was reserved always resolves
 *   8. audit and event       -> evidence, and the input to analytics
 */
@Injectable()
export class CreateChatCompletion {
  private readonly guardrailPipeline = new GuardrailPipeline([
    new BlockOnDecisionStage(),
    new RejectInjectionStage(),
  ]);

  constructor(
    @Inject(POLICY_READER) private readonly policies: PolicyReader,
    @Inject(ALIAS_REGISTRY) private readonly aliases: AliasRegistry,
    @Inject(BUDGET_LEDGER) private readonly ledger: BudgetLedger,
    @Inject(GUARDRAIL) private readonly guardrail: Guardrail,
    @Inject(SEMANTIC_CACHE) private readonly cache: SemanticCache,
    @Inject(TOKEN_ESTIMATOR) private readonly estimator: TokenEstimator,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(USAGE_PUBLISHER) private readonly usage: UsagePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BULKHEAD) private readonly bulkhead: Bulkhead,
    private readonly executor: DeploymentExecutor,
  ) {}

  /**
   * A slot for this project, or a 429.
   *
   * Taken AFTER the cache lookup on purpose: an answer already in Redis costs
   * nothing to serve, and refusing it for concurrency would make the platform
   * least available exactly when the cache is doing the most good.
   *
   * The limit comes from the project's own policy rather than from
   * `POLICIES.INFERENCE.bulkhead`, which carries only the shape -- how long to
   * wait for a slot, how long a lease may outlive a dead process. How many
   * requests a project may run at once is a governance decision, changeable
   * without a deploy.
   */
  private admit(plan: Plan, projectId: string): Promise<BulkheadLease> {
    return this.bulkhead.acquire(projectId, plan.policyResult.maxConcurrentRequests);
  }

  async execute(command: CreateChatCompletionCommand): Promise<ChatCompletionResult> {
    const plan = await this.prepare(command);
    const startedAt = this.clock.now();

    if (plan.cached !== null) {
      return this.finishFromCache(command, plan, startedAt);
    }

    // Before the budget reservation: a request refused for concurrency must not
    // have reserved money it will never spend, and releasing a reservation the
    // caller never got an answer for is work with no purpose.
    const lease = await this.admit(plan, command.projectId);

    // The reservation is INSIDE the try, and that is the whole point of the
    // nesting: `reserve` throws when the budget is exhausted, and with it
    // outside, the `finally` below never ran. A project at its limit under load
    // then leaked a slot per refused request until the lease TTL, so
    // `budget_exhausted` quietly turned into `concurrency_limit` as well.
    try {
      const reservation = await this.reserve(command, plan);

      try {
        const attempt = await this.executor.chat(
          plan.request,
          plan.deployments,
          { stream: false },
          this.callerOf(command, plan),
        );
        const cost = attempt.deployment.costOf(
          attempt.result.usage.promptTokens,
          attempt.result.usage.completionTokens,
        );

        await this.commit(reservation, cost);
        if (plan.cacheable) {
          await this.cache.store(command.projectId, command.alias, plan.promptForCache, {
            content: attempt.result.content,
            usage: attempt.result.usage,
            deploymentId: attempt.deployment.id,
          });
        }

        const routing = this.routingOf({
          deployment: attempt.deployment,
          cost,
          plan,
          attempts: attempt.attempts,
          cacheHit: false,
        });
        await this.settle({
          command,
          plan,
          routing,
          usage: attempt.result.usage,
          startedAt,
          status: 'completed',
        });

        return {
          id: command.requestId,
          model: command.alias,
          content: attempt.result.content,
          finishReason: attempt.result.finishReason,
          usage: totals(attempt.result.usage),
          routing,
          ...(attempt.result.toolCalls !== undefined && { toolCalls: attempt.result.toolCalls }),
        };
      } catch (error) {
        // Saga compensation: whatever was reserved must not stay locked.
        await this.ledger.release(reservation);
        await this.recordFailure(command, plan, error, startedAt);
        throw error;
      }
    } finally {
      await lease.release();
    }
  }

  /**
   * The streaming variant.
   *
   * After the first token no retry is possible: the client has already seen part
   * of the answer. If the stream drops, the partial usage is committed and marked
   * `partial`, and reconciliation corrects it later.
   */
  async *stream(command: CreateChatCompletionCommand): AsyncGenerator<StreamEvent> {
    const plan = await this.prepare(command);
    const startedAt = this.clock.now();

    if (plan.cached !== null) {
      const result = await this.finishFromCache(command, plan, startedAt);
      yield { kind: 'delta', content: result.content };
      yield { kind: 'finished', result };
      return;
    }

    // Held for the whole stream, not just until the first token: a generation
    // that runs for two minutes occupies the project's capacity for two
    // minutes, and `POLICIES.INFERENCE_STREAMING` gives the lease a longer TTL
    // for exactly that reason.
    const lease = await this.admit(plan, command.projectId);

    // Reserved inside the try for the same reason `execute` does it: a budget
    // refusal must not leave the slot held. Declared out here because the catch
    // and the finally both have to know whether there is anything to settle.
    let reservation: BudgetReservation | undefined;
    let emitted = '';
    let firstTokenAt: Date | undefined;
    let usage: TokenUsage = { promptTokens: plan.estimatedPromptTokens, completionTokens: 0 };
    let deployment: Deployment | undefined;
    let attempts = 0;
    let finishReason: string | null = null;
    let toolCalls: ToolCallOutput[] = [];

    try {
      // Assigns the outer binding, deliberately: a `const` here would shadow it,
      // leaving the catch and the finally looking at an undefined reservation.
      reservation = await this.reserve(command, plan);
      const opened = await this.executor.openStream(
        plan.request,
        plan.deployments,
        this.callerOf(command, plan),
      );
      deployment = opened.deployment;
      attempts = opened.attempts;

      for await (const chunk of opened.chunks) {
        if (chunk.delta !== '') {
          firstTokenAt ??= this.clock.now();
          emitted += chunk.delta;
          yield { kind: 'delta', content: chunk.delta };
        }
        ({ usage, toolCalls, finishReason } = fold(chunk, { usage, toolCalls, finishReason }));
      }

      // A provider that reports no usage: estimate from what was actually
      // emitted, so the budget is never undercharged.
      if (usage.completionTokens === 0 && emitted !== '') {
        usage = { ...usage, completionTokens: this.estimator.countText(emitted) };
      }

      const cost = deployment.costOf(usage.promptTokens, usage.completionTokens);
      await this.commit(reservation, cost);

      const routing = this.routingOf({ deployment, cost, plan, attempts, cacheHit: false });
      const result: ChatCompletionResult = {
        id: command.requestId,
        model: command.alias,
        content: emitted,
        // A provider can report the calls without ever setting the reason.
        finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
        usage: totals(usage),
        routing,
        ...(toolCalls.length > 0 && { toolCalls }),
      };

      await this.settle({
        command,
        plan,
        routing,
        usage,
        startedAt,
        status: 'completed',
        extra: {
          completion: emitted,
          ...(firstTokenAt !== undefined && {
            timeToFirstTokenMs: firstTokenAt.getTime() - startedAt.getTime(),
          }),
        },
      });

      yield { kind: 'finished', result };
    } catch (error) {
      if (emitted !== '' && deployment !== undefined && reservation !== undefined) {
        // Partial delivery already happened: commit what was consumed and flag it.
        const partialUsage = {
          promptTokens: usage.promptTokens,
          completionTokens: this.estimator.countText(emitted),
        };
        const cost = deployment.costOf(partialUsage.promptTokens, partialUsage.completionTokens);
        await this.commit(reservation, cost);

        const routing = this.routingOf({ deployment, cost, plan, attempts, cacheHit: false });
        await this.settle({
          command,
          plan,
          routing,
          usage: partialUsage,
          startedAt,
          status: 'partial',
          extra: { completion: emitted, errorCode: 'stream_interrupted' },
        });

        const interrupted = new StreamInterruptedError(
          error instanceof Error ? error.message : 'unknown',
          partialUsage.completionTokens,
        );
        yield { kind: 'error', code: interrupted.code, message: interrupted.message };
        return;
      }

      await this.recordFailure(command, plan, error, startedAt);
      throw error;
    } finally {
      await this.letGo(reservation, lease);
    }
  }

  /**
   * Gives back whatever a stream that did not finish is still holding.
   *
   * In a `finally`, because a generator abandoned by its consumer runs nothing
   * else: no catch, no commit. The slot was already released here -- a client
   * that disconnects would otherwise hold it until the lease TTL -- and the
   * reservation was not, so the money stayed held and the project's remaining
   * budget under-reported until the reservation expired on its own.
   *
   * Releasing what was already committed or released is a no-op in the ledger,
   * which is what lets the compensation live in one place instead of being
   * threaded through every exit.
   */
  private async letGo(
    reservation: BudgetReservation | undefined,
    lease: BulkheadLease,
  ): Promise<void> {
    if (reservation !== undefined) await this.ledger.release(reservation);
    await lease.release();
  }

  /* ---------------------------------------------------------------- */

  private async prepare(command: CreateChatCompletionCommand): Promise<Plan> {
    const policyResult = await this.policies.forProject(command.projectId);
    const alias = await this.aliases.find(command.alias);
    if (alias === null) throw new AliasNotFoundError(command.alias);

    const deployments = ModelSelectionPolicy.compatible(alias, policyResult.policy, 'chat');
    const first = deployments[0];
    // `compatible` throws when the list is empty; this check is for the type.
    if (first === undefined) throw new AliasNotFoundError(command.alias);

    const maxOutputTokens = ModelSelectionPolicy.effectiveMaxOutputTokens(
      command.maxTokens,
      first,
      policyResult.policy,
      command.alias,
    );

    const guarded = await this.applyGuardrails(command, policyResult.policy.classification);
    const messages = guarded.messages;
    const promptForCache = messages.map((message) => message.content ?? '').join('\n');

    const request: ChatRequestInput = {
      messages,
      maxOutputTokens,
      ...(command.temperature !== undefined && { temperature: command.temperature }),
      ...(command.topP !== undefined && { topP: command.topP }),
      ...(command.stop !== undefined && { stop: command.stop }),
      ...(command.tools !== undefined && command.tools.length > 0 && { tools: command.tools }),
      ...(command.toolChoice !== undefined && { toolChoice: command.toolChoice }),
    };

    // A tool-using turn never touches the cache. The cache stores text keyed by
    // the prompt, so the same question asked with a different toolset would come
    // back as a stale answer where the model wanted to call something -- the
    // agent would silently skip the call it was about to make.
    const cacheable = request.tools === undefined;
    const cached = cacheable
      ? await this.cache.lookup(command.projectId, command.alias, promptForCache)
      : null;

    return {
      policyResult,
      guardrailsUnverified: guarded.unverified,
      deployments,
      request,
      promptForCache,
      cacheable,
      cached,
      estimatedPromptTokens: this.estimator.countMessages(messages),
      maxOutputTokens,
    };
  }

  /**
   * Redacts PII in the prompt BEFORE any external call or persistence.
   *
   * If the guardrails service is down, the content proceeds unredacted but audit
   * does not store the text: blocking all inference because of the guardrail
   * would trade a risk for an outage.
   */
  private async applyGuardrails(
    command: CreateChatCompletionCommand,
    classification: DataClassification,
  ): Promise<{ messages: CreateChatCompletionCommand['messages']; unverified: boolean }> {
    if (!this.guardrail.available) {
      this.refuseUnverifiedRestricted(classification, command.projectId);
      return { messages: command.messages, unverified: true };
    }

    const inspected: CreateChatCompletionCommand['messages'] = [];
    let unverified = false;

    for (const message of command.messages) {
      if (message.content === null || message.content === '') {
        inspected.push(message);
        continue;
      }

      const verdict = await this.guardrail.inspect(message.content, command.projectId);
      // One unverified message makes the whole request unverified: what matters
      // downstream is whether anything reached a provider uninspected.
      if (verdict.unverified) {
        this.refuseUnverifiedRestricted(classification, command.projectId);
        unverified = true;
      }
      // The pipeline decides whether to block; the text that proceeds is redacted.
      const context = await this.guardrailPipeline.run(verdict.text, command.projectId, verdict);
      inspected.push({ ...message, content: context.text });
    }
    return { messages: inspected, unverified };
  }

  /**
   * ADR-026: a restricted project fails closed.
   *
   * Everywhere else the platform keeps answering with the content uninspected,
   * because refusing every request over a downed guardrail trades a risk for an
   * outage. `restricted` is the classification that says the trade is not
   * available: a project whose promise is that its data never leaves unredacted
   * cannot keep that promise with the redactor unreachable.
   */
  private refuseUnverifiedRestricted(classification: DataClassification, projectId: string): void {
    if (classification === 'restricted') throw new GuardrailUnavailableError(projectId);
  }

  /**
   * Commits the real cost, and records it on the span.
   *
   * A method rather than three annotated call sites: the blocking path, the
   * streaming path and the partial-delivery path all commit, and a fourth
   * added later would otherwise be the one that forgets.
   */
  private async commit(reservation: BudgetReservation, cost: Cost): Promise<void> {
    await this.ledger.commit(reservation, cost);
    annotateOutcome({ budgetCommittedMicros: Number(cost.micros) });
  }

  private async reserve(
    command: CreateChatCompletionCommand,
    plan: Plan,
  ): Promise<BudgetReservation> {
    const first = plan.deployments[0];
    if (first === undefined) throw new AliasNotFoundError(command.alias);

    // The estimate uses the locally counted prompt plus the output ceiling: the
    // worst case that call could cost (reference doc 02, flow 7.1).
    const estimated = first.costOf(plan.estimatedPromptTokens, plan.maxOutputTokens);

    if (!this.ledger.isAvailable()) {
      return BudgetReservation.unverified(command.projectId, plan.policyResult.currency);
    }

    let reservation: BudgetReservation;
    try {
      reservation = await this.ledger.reserve({
        projectId: command.projectId,
        estimated,
        periodKey: plan.policyResult.periodKey,
        periodEndsInSeconds: plan.policyResult.periodEndsInSeconds,
        limitMicros: plan.policyResult.limitMicros,
        blockAtLimit: plan.policyResult.blockAtLimit,
      });
    } catch (error) {
      // Counted apart from the failures, because a refusal on budget is not
      // one: the platform did exactly what it was told to. A rising rejection
      // rate is a conversation with a customer; a rising error rate is an
      // incident, and a dashboard that mixes them tells you neither.
      if (error instanceof BudgetExhaustedError) {
        recordBudgetRejection({ projectId: command.projectId, alias: command.alias });
      }
      throw error;
    }

    // The estimate, not the cost: the gap between the two is what says whether
    // the ceiling this platform holds against a project's balance is anywhere
    // near what its calls actually spend.
    annotateOutcome({ budgetReservedMicros: Number(reservation.estimated.micros) });
    return reservation;
  }

  private async finishFromCache(
    command: CreateChatCompletionCommand,
    plan: Plan,
    startedAt: Date,
  ): Promise<ChatCompletionResult> {
    const cached = plan.cached;
    const deployment = plan.deployments[0];
    if (cached === null || deployment === undefined) throw new AliasNotFoundError(command.alias);

    // A cache hit consumes no budget: there was no provider call.
    const routing = this.routingOf({
      deployment,
      cost: Cost.zero(plan.policyResult.currency),
      plan,
      attempts: 0,
      cacheHit: true,
    });
    await this.settle({
      command,
      plan,
      routing,
      usage: cached.usage,
      startedAt,
      status: 'completed',
      extra: { completion: cached.content },
    });

    return {
      id: command.requestId,
      model: command.alias,
      content: cached.content,
      finishReason: 'stop',
      usage: totals(cached.usage),
      routing,
    };
  }

  /**
   * Who the model call is for, for the span the executor opens.
   *
   * The provider-facing request deliberately carries no tenant -- it is what
   * goes on the wire to OpenAI -- so the identity travels beside it instead of
   * inside it.
   */
  private callerOf(command: CreateChatCompletionCommand, plan: Plan): BusinessContext {
    return {
      projectId: command.projectId,
      principalId: command.principalId,
      alias: command.alias,
      dataClassification: plan.policyResult.policy.classification,
    };
  }

  private routingOf(input: {
    deployment: Deployment;
    cost: Cost;
    plan: Plan;
    attempts: number;
    cacheHit: boolean;
  }): RoutingInfo {
    const { deployment, cost, plan, attempts, cacheHit } = input;
    return {
      deploymentId: deployment.id,
      provider: deployment.provider,
      providerModel: deployment.model,
      dataZone: deployment.dataZone,
      cost,
      cacheHit,
      policyStale: plan.policyResult.stale,
      budgetUnverified: !this.ledger.isAvailable(),
      guardrailsUnverified: plan.guardrailsUnverified,
      attempts,
    };
  }

  /** Audit and event. Both always happen, on success and on failure. */
  private async settle(input: {
    command: CreateChatCompletionCommand;
    plan: Plan;
    routing: RoutingInfo;
    usage: TokenUsage;
    startedAt: Date;
    status: UsageStatus;
    extra?: { completion?: string; timeToFirstTokenMs?: number; errorCode?: string };
  }): Promise<void> {
    const { command, plan, routing, usage, startedAt, status } = input;
    const extra = input.extra ?? {};
    const now = this.clock.now();
    const durationMs = now.getTime() - startedAt.getTime();

    // Onto the request's own span, because `settle` is the one place that runs
    // on every path -- cache hit, success and failure alike. Every one of these
    // was already computed here for the audit and the event, and reached no
    // span: "how much traffic did we serve on a stale policy last Tuesday" was
    // a question only answerable by reading a database.
    annotateOutcome({
      cacheHit: routing.cacheHit,
      policyStale: routing.policyStale,
      budgetUnverified: routing.budgetUnverified,
      guardrailsUnverified: routing.guardrailsUnverified,
    });

    // The same numbers as the event below, as METRICS. The event is the record
    // of one call and the audit is the evidence; neither can answer "what is
    // the p95 this hour" without a scan per panel refresh, which is what a
    // dashboard would need on every reload.
    recordInference({
      projectId: command.projectId,
      alias: command.alias,
      provider: routing.provider,
      dataZone: routing.dataZone,
      status,
      durationMs,
      ...(extra.timeToFirstTokenMs !== undefined && {
        timeToFirstTokenMs: extra.timeToFirstTokenMs,
      }),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costMicros: Number(routing.cost.micros),
    });

    const record: UsageRecorded = {
      requestId: command.requestId,
      projectId: command.projectId,
      principalId: command.principalId,
      alias: command.alias,
      provider: routing.provider,
      providerModel: routing.providerModel,
      deploymentId: routing.deploymentId,
      dataZone: routing.dataZone,
      dataClassification: plan.policyResult.policy.classification,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cost: routing.cost,
      durationMs,
      ...(extra.timeToFirstTokenMs !== undefined && {
        timeToFirstTokenMs: extra.timeToFirstTokenMs,
      }),
      cacheHit: routing.cacheHit,
      status,
      ...(extra.errorCode !== undefined && { errorCode: extra.errorCode }),
      budgetUnverified: routing.budgetUnverified,
      guardrailsUnverified: routing.guardrailsUnverified,
      policyStale: routing.policyStale,
      occurredAt: now,
    };

    await Promise.all([
      this.audit.record({
        requestId: command.requestId,
        projectId: command.projectId,
        principalId: command.principalId,
        alias: command.alias,
        deploymentId: routing.deploymentId,
        provider: routing.provider,
        dataZone: routing.dataZone,
        status,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costMicros: Number(routing.cost.micros),
        currency: routing.cost.currency,
        durationMs,
        ...(extra.errorCode !== undefined && { errorCode: extra.errorCode }),
        guardrailsUnverified: routing.guardrailsUnverified,
        expiresAt: expiryFrom(now, plan.policyResult.contentRetentionDays),
        // Content is stored only with the project's opt-in, and it arrives
        // already redacted from the guardrail pipeline (doc 02 §10.2).
        ...(plan.policyResult.contentCapture && {
          redactedPrompt: plan.promptForCache,
          ...(extra.completion !== undefined && { redactedCompletion: extra.completion }),
        }),
        occurredAt: now,
      }),
      this.usage.publish(record),
    ]);
  }

  private async recordFailure(
    command: CreateChatCompletionCommand,
    plan: Plan,
    error: unknown,
    startedAt: Date,
  ): Promise<void> {
    const deployment = plan.deployments[0];
    if (deployment === undefined) return;

    const code = (error as { code?: string }).code ?? 'internal_error';
    const routing = this.routingOf({
      deployment,
      cost: Cost.zero(plan.policyResult.currency),
      plan,
      attempts: 0,
      cacheHit: false,
    });

    await this.settle({
      command,
      plan,
      routing,
      usage: { promptTokens: plan.estimatedPromptTokens, completionTokens: 0 },
      startedAt,
      status: 'failed',
      extra: { errorCode: code },
    });
  }
}

/** The metadata a chunk may carry. Kept out of the loop so the streaming path
 *  stays under the complexity the lint rule allows — and so what is remembered
 *  across chunks is stated in one place. */
interface StreamTotals {
  usage: TokenUsage;
  toolCalls: ToolCallOutput[];
  finishReason: string | null;
}

function fold(chunk: ChatChunk, totals: StreamTotals): StreamTotals {
  return {
    usage: chunk.usage ?? totals.usage,
    toolCalls: chunk.toolCalls ?? totals.toolCalls,
    // `?? ` covers both: a chunk with no reason and one that reports null are
    // the same thing -- the answer has not ended yet.
    finishReason: chunk.finishReason ?? totals.finishReason,
  };
}

interface Plan {
  policyResult: PolicyResult;
  guardrailsUnverified: boolean;
  deployments: Deployment[];
  request: ChatRequestInput;
  promptForCache: string;
  cacheable: boolean;
  cached: Awaited<ReturnType<SemanticCache['lookup']>>;
  estimatedPromptTokens: number;
  maxOutputTokens: number;
}

function totals(usage: TokenUsage): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
  };
}

/** When a record written now stops existing, given the project's retention. */
function expiryFrom(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

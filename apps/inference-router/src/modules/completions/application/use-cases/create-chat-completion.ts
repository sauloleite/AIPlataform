import { Inject, Injectable } from '@nestjs/common';
import { AliasNotFoundError, StreamInterruptedError } from '../../domain/errors/index.js';
import { BudgetReservation } from '../../domain/entities/budget-reservation.js';
import { ModelSelectionPolicy } from '../../domain/services/model-selection-policy.js';
import { Cost } from '../../domain/value-objects/index.js';
import type { Deployment } from '../../domain/entities/deployment.js';
import type { UsageRecorded, UsageStatus } from '../../domain/events/usage-recorded.js';
import {
  ALIAS_REGISTRY,
  AUDIT_REPOSITORY,
  BUDGET_LEDGER,
  CLOCK,
  GUARDRAIL,
  POLICY_READER,
  SEMANTIC_CACHE,
  TOKEN_ESTIMATOR,
  USAGE_PUBLISHER,
  type AliasRegistry,
  type AuditRepository,
  type BudgetLedger,
  type ChatRequestInput,
  type Clock,
  type Guardrail,
  type PolicyReader,
  type PolicyResult,
  type SemanticCache,
  type TokenEstimator,
  type TokenUsage,
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
 * Fluxo 7.1 do documento 02: chat com reserva e commit de orcamento.
 *
 * Ordem das etapas, e o porque de cada uma:
 *   1. politica do projeto        -> define zonas, limites e orcamento
 *   2. guardrails no prompt       -> redige PII ANTES de sair da plataforma
 *   3. selecao de deployment      -> ADR-010, dado sensivel nao sai da zona
 *   4. cache semantico            -> resposta repetida nao custa nem token
 *   5. reserva de orcamento       -> impede N chamadas gastarem o mesmo saldo
 *   6. chamada ao provedor        -> com failover entre deployments compativeis
 *   7. commit ou compensacao      -> saga: o que foi reservado sempre se resolve
 *   8. auditoria e evento         -> evidencia e insumo do analitico
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
    private readonly executor: DeploymentExecutor,
  ) {}

  async execute(command: CreateChatCompletionCommand): Promise<ChatCompletionResult> {
    const plan = await this.prepare(command);
    const startedAt = this.clock.now();

    if (plan.cached !== null) {
      return this.finishFromCache(command, plan, startedAt);
    }

    const reservation = await this.reserve(command, plan);

    try {
      const attempt = await this.executor.chat(plan.request, plan.deployments, {
        stream: false,
      });
      const cost = attempt.deployment.costOf(
        attempt.result.usage.promptTokens,
        attempt.result.usage.completionTokens,
      );

      await this.ledger.commit(reservation, cost);
      await this.cache.store(command.projectId, command.alias, plan.promptForCache, {
        content: attempt.result.content,
        usage: attempt.result.usage,
        deploymentId: attempt.deployment.id,
      });

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
      };
    } catch (error) {
      // Compensacao da saga: o que foi reservado nao pode ficar preso.
      await this.ledger.release(reservation);
      await this.recordFailure(command, plan, error, startedAt);
      throw error;
    }
  }

  /**
   * Versao em streaming.
   *
   * Depois do primeiro token nao ha retentativa possivel: o cliente ja viu parte
   * da resposta. Se o stream cair, o consumo parcial e comitado e marcado como
   * `partial`, e a reconciliacao ajusta depois.
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

    const reservation = await this.reserve(command, plan);

    let emitted = '';
    let firstTokenAt: Date | undefined;
    let usage: TokenUsage = { promptTokens: plan.estimatedPromptTokens, completionTokens: 0 };
    let deployment: Deployment | undefined;
    let attempts = 0;
    let finishReason: string | null = null;

    try {
      const opened = await this.executor.openStream(plan.request, plan.deployments);
      deployment = opened.deployment;
      attempts = opened.attempts;

      for await (const chunk of opened.chunks) {
        if (chunk.delta !== '') {
          firstTokenAt ??= this.clock.now();
          emitted += chunk.delta;
          yield { kind: 'delta', content: chunk.delta };
        }
        if (chunk.usage !== undefined) usage = chunk.usage;
        if (chunk.finishReason !== undefined && chunk.finishReason !== null) {
          finishReason = chunk.finishReason;
        }
      }

      // Provedor que nao informa consumo: estima pelo que foi realmente emitido,
      // para que o orcamento nunca seja debitado a menos.
      if (usage.completionTokens === 0 && emitted !== '') {
        usage = { ...usage, completionTokens: this.estimator.countText(emitted) };
      }

      const cost = deployment.costOf(usage.promptTokens, usage.completionTokens);
      await this.ledger.commit(reservation, cost);

      const routing = this.routingOf({ deployment, cost, plan, attempts, cacheHit: false });
      const result: ChatCompletionResult = {
        id: command.requestId,
        model: command.alias,
        content: emitted,
        finishReason,
        usage: totals(usage),
        routing,
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
      if (emitted !== '' && deployment !== undefined) {
        // Ja houve entrega parcial: comita o consumido e marca como parcial.
        const partialUsage = {
          promptTokens: usage.promptTokens,
          completionTokens: this.estimator.countText(emitted),
        };
        const cost = deployment.costOf(partialUsage.promptTokens, partialUsage.completionTokens);
        await this.ledger.commit(reservation, cost);

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
          error instanceof Error ? error.message : 'desconhecido',
          partialUsage.completionTokens,
        );
        yield { kind: 'error', code: interrupted.code, message: interrupted.message };
        return;
      }

      await this.ledger.release(reservation);
      await this.recordFailure(command, plan, error, startedAt);
      throw error;
    }
  }

  /* ---------------------------------------------------------------- */

  private async prepare(command: CreateChatCompletionCommand): Promise<Plan> {
    const policyResult = await this.policies.forProject(command.projectId);
    const alias = await this.aliases.find(command.alias);
    if (alias === null) throw new AliasNotFoundError(command.alias);

    const deployments = ModelSelectionPolicy.compatible(alias, policyResult.policy, 'chat');
    const first = deployments[0];
    // `compatible` lanca quando a lista fica vazia; este check e para o tipo.
    if (first === undefined) throw new AliasNotFoundError(command.alias);

    const maxOutputTokens = ModelSelectionPolicy.effectiveMaxOutputTokens(
      command.maxTokens,
      first,
      policyResult.policy,
      command.alias,
    );

    const messages = await this.applyGuardrails(command);
    const promptForCache = messages.map((message) => message.content ?? '').join('\n');

    const request: ChatRequestInput = {
      messages,
      maxOutputTokens,
      ...(command.temperature !== undefined && { temperature: command.temperature }),
      ...(command.topP !== undefined && { topP: command.topP }),
      ...(command.stop !== undefined && { stop: command.stop }),
    };

    const cached = await this.cache.lookup(command.projectId, command.alias, promptForCache);

    return {
      policyResult,
      deployments,
      request,
      promptForCache,
      cached,
      estimatedPromptTokens: this.estimator.countMessages(messages),
      maxOutputTokens,
    };
  }

  /**
   * Redige PII no prompt ANTES de qualquer chamada externa ou persistencia.
   *
   * Se o servico de guardrails estiver fora, o conteudo segue sem redacao mas a
   * auditoria nao grava o texto: bloquear toda a inferencia por causa do
   * guardrail seria trocar um risco por uma indisponibilidade.
   */
  private async applyGuardrails(
    command: CreateChatCompletionCommand,
  ): Promise<CreateChatCompletionCommand['messages']> {
    if (!this.guardrail.available) return command.messages;

    const inspected: CreateChatCompletionCommand['messages'] = [];
    for (const message of command.messages) {
      if (message.content === null || message.content === '') {
        inspected.push(message);
        continue;
      }

      const verdict = await this.guardrail.inspect(message.content, command.projectId);
      // O pipeline decide se bloqueia; o texto que segue e o ja redigido.
      const context = await this.guardrailPipeline.run(verdict.text, command.projectId, verdict);
      inspected.push({ ...message, content: context.text });
    }
    return inspected;
  }

  private async reserve(
    command: CreateChatCompletionCommand,
    plan: Plan,
  ): Promise<BudgetReservation> {
    const first = plan.deployments[0];
    if (first === undefined) throw new AliasNotFoundError(command.alias);

    // A estimativa usa o prompt contado localmente mais o teto de saida: o pior
    // caso possivel daquela chamada (doc 02, fluxo 7.1).
    const estimated = first.costOf(plan.estimatedPromptTokens, plan.maxOutputTokens);

    if (!this.ledger.isAvailable()) {
      return BudgetReservation.unverified(command.projectId, plan.policyResult.currency);
    }

    return this.ledger.reserve({
      projectId: command.projectId,
      estimated,
      periodKey: plan.policyResult.periodKey,
      periodEndsInSeconds: plan.policyResult.periodEndsInSeconds,
      limitMicros: plan.policyResult.limitMicros,
      blockAtLimit: plan.policyResult.blockAtLimit,
    });
  }

  private async finishFromCache(
    command: CreateChatCompletionCommand,
    plan: Plan,
    startedAt: Date,
  ): Promise<ChatCompletionResult> {
    const cached = plan.cached;
    const deployment = plan.deployments[0];
    if (cached === null || deployment === undefined) throw new AliasNotFoundError(command.alias);

    // Cache hit nao consome orcamento: nao houve chamada ao provedor.
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
      attempts,
    };
  }

  /** Auditoria e evento. Sempre acontecem, com sucesso ou com falha. */
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
        // Conteudo so e gravado com opt-in do projeto, e ja vem redigido do
        // pipeline de guardrails (doc 02, secao 10.2).
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

interface Plan {
  policyResult: PolicyResult;
  deployments: Deployment[];
  request: ChatRequestInput;
  promptForCache: string;
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

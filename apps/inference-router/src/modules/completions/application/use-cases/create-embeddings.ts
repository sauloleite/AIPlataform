import { Inject, Injectable } from '@nestjs/common';
import { AliasNotFoundError } from '../../domain/errors/index.js';
import { BudgetReservation } from '../../domain/entities/budget-reservation.js';
import { ModelSelectionPolicy } from '../../domain/services/model-selection-policy.js';
import {
  ALIAS_REGISTRY,
  BUDGET_LEDGER,
  CLOCK,
  POLICY_READER,
  TOKEN_ESTIMATOR,
  USAGE_PUBLISHER,
  type AliasRegistry,
  type BudgetLedger,
  type Clock,
  type PolicyReader,
  type TokenEstimator,
  type UsagePublisher,
} from '../ports.js';
import { DeploymentExecutor } from '../services/deployment-executor.js';
import type { CreateEmbeddingsCommand, EmbeddingsResult } from '../dto.js';

/**
 * Embeddings passam pelo mesmo controle de orcamento e de zona de dados que o
 * chat: e o mesmo conteudo saindo da plataforma, so que em outro formato.
 */
@Injectable()
export class CreateEmbeddings {
  constructor(
    @Inject(POLICY_READER) private readonly policies: PolicyReader,
    @Inject(ALIAS_REGISTRY) private readonly aliases: AliasRegistry,
    @Inject(BUDGET_LEDGER) private readonly ledger: BudgetLedger,
    @Inject(TOKEN_ESTIMATOR) private readonly estimator: TokenEstimator,
    @Inject(USAGE_PUBLISHER) private readonly usage: UsagePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly executor: DeploymentExecutor,
  ) {}

  async execute(command: CreateEmbeddingsCommand): Promise<EmbeddingsResult> {
    const policyResult = await this.policies.forProject(command.projectId);
    const alias = await this.aliases.find(command.alias);
    if (alias === null) throw new AliasNotFoundError(command.alias);

    const deployments = ModelSelectionPolicy.compatible(alias, policyResult.policy, 'embeddings');
    const first = deployments[0];
    if (first === undefined) throw new AliasNotFoundError(command.alias);

    const estimatedTokens = command.input.reduce(
      (total, text) => total + this.estimator.countText(text),
      0,
    );

    const reservation = this.ledger.isAvailable()
      ? await this.ledger.reserve({
          projectId: command.projectId,
          estimated: first.costOf(estimatedTokens, 0),
          periodKey: policyResult.periodKey,
          periodEndsInSeconds: policyResult.periodEndsInSeconds,
          limitMicros: policyResult.limitMicros,
          blockAtLimit: policyResult.blockAtLimit,
        })
      : BudgetReservation.unverified(command.projectId, policyResult.currency);

    const startedAt = this.clock.now();

    try {
      const attempt = await this.executor.embed(command.input, deployments);
      const cost = attempt.deployment.costOf(attempt.result.usage.promptTokens, 0);
      await this.ledger.commit(reservation, cost);

      const now = this.clock.now();
      await this.usage.publish({
        requestId: command.requestId,
        projectId: command.projectId,
        principalId: command.principalId,
        alias: command.alias,
        provider: attempt.deployment.provider,
        providerModel: attempt.deployment.model,
        deploymentId: attempt.deployment.id,
        dataZone: attempt.deployment.dataZone,
        dataClassification: policyResult.policy.classification,
        promptTokens: attempt.result.usage.promptTokens,
        completionTokens: 0,
        cost,
        durationMs: now.getTime() - startedAt.getTime(),
        cacheHit: false,
        status: 'completed',
        budgetUnverified: !this.ledger.isAvailable(),
        policyStale: policyResult.stale,
        occurredAt: now,
      });

      return {
        model: command.alias,
        vectors: attempt.result.vectors,
        usage: {
          promptTokens: attempt.result.usage.promptTokens,
          completionTokens: 0,
          totalTokens: attempt.result.usage.promptTokens,
        },
        routing: {
          deploymentId: attempt.deployment.id,
          provider: attempt.deployment.provider,
          providerModel: attempt.deployment.model,
          dataZone: attempt.deployment.dataZone,
          cost,
          cacheHit: false,
          policyStale: policyResult.stale,
          budgetUnverified: !this.ledger.isAvailable(),
          attempts: attempt.attempts,
        },
      };
    } catch (error) {
      await this.ledger.release(reservation);
      throw error;
    }
  }
}

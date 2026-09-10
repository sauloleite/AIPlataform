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
 * Embeddings go through the same budget and data zone controls as chat: it is
 * the same content leaving the platform, just in a different shape.
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
      const attempt = await this.executor.embed(command.input, deployments, {
        projectId: command.projectId,
        principalId: command.principalId,
        alias: command.alias,
        dataClassification: policyResult.policy.classification,
      });
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
        guardrailsUnverified: false,
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
          // Embeddings do not go through the guardrail pipeline: the text is
          // already redacted by whoever indexed it, and re-inspecting a corpus
          // chunk by chunk would double the cost of every ingestion. Reported
          // as verified rather than left out, so the field means one thing.
          guardrailsUnverified: false,
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

import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@aia/errors';
import { EVENT_TYPES, newEvent } from '@aia/messaging';
import { Budget } from '../../domain/entities/budget.js';
import { Money } from '../../domain/value-objects/money.js';
import {
  BUDGET_REPOSITORY,
  CLOCK,
  PROJECT_REPOSITORY,
  type BudgetRepository,
  type Clock,
  type ProjectRepository,
} from '../ports.js';
import type { BudgetView, SetBudgetCommand } from '../dto.js';
import { toBudgetView } from '../mappers.js';

const SOURCE = '/aia/governance';

@Injectable()
export class SetBudget {
  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly budgets: BudgetRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: SetBudgetCommand): Promise<BudgetView> {
    const project = await this.projects.findById(command.projectId);
    if (project === null) throw new NotFoundError('Project', command.projectId);

    const now = this.clock.now();
    const limit = Money.of(BigInt(command.limitMicros), command.currency);
    const existing = await this.budgets.findByProject(command.projectId);

    // Changing the limit preserves the period's spend; only creating anew resets.
    const budget =
      existing === null
        ? Budget.create({
            projectId: command.projectId,
            limit,
            period: command.period,
            ...(command.blockAtLimit !== undefined && { blockAtLimit: command.blockAtLimit }),
            ...(command.alertThresholds !== undefined && {
              alertThresholds: command.alertThresholds,
            }),
            now,
          })
        : this.updateExisting(existing, limit, command, now);

    await this.budgets.save(budget, [
      newEvent({
        type: EVENT_TYPES.BUDGET_CHANGED,
        source: SOURCE,
        projectId: command.projectId,
        time: now,
        data: {
          project_id: command.projectId,
          limit_micros: command.limitMicros,
          currency: command.currency,
          period: command.period,
          block_at_limit: budget.blockAtLimit,
        },
      }),
    ]);

    return toBudgetView(budget);
  }

  private updateExisting(
    budget: Budget,
    limit: Money,
    command: SetBudgetCommand,
    now: Date,
  ): Budget {
    if (budget.isExpired(now)) budget.rollOver(now);
    budget.changeLimit(limit);
    budget.changePolicy({
      ...(command.blockAtLimit !== undefined && { blockAtLimit: command.blockAtLimit }),
      ...(command.alertThresholds !== undefined && { alertThresholds: command.alertThresholds }),
    });
    return budget;
  }
}

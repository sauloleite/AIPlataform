import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@aia/errors';
import {
  BUDGET_REPOSITORY,
  CLOCK,
  PROJECT_REPOSITORY,
  type BudgetRepository,
  type Clock,
  type ProjectRepository,
} from '../ports.js';
import type { ProjectPolicyView } from '../dto.js';
import { toPolicyView } from '../mappers.js';

/**
 * The project's effective policy.
 *
 * This is the service's busiest endpoint: the inference router consults it on
 * every request, through a local cache with a short TTL. That is why it performs
 * no writes and depends on nothing beyond the two repositories.
 */
@Injectable()
export class GetProjectPolicy {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(BUDGET_REPOSITORY) private readonly budgets: BudgetRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(projectId: string): Promise<ProjectPolicyView> {
    const project = await this.projects.findById(projectId);
    if (project === null) throw new NotFoundError('Project', projectId);

    const budget = await this.budgets.findByProject(projectId);
    // An expired period's budget must not read as spend: the router would make
    // the wrong decision until the roll-over is persisted.
    if (budget?.isExpired(this.clock.now()) === true) {
      budget.rollOver(this.clock.now());
    }

    return toPolicyView(project, budget);
  }
}

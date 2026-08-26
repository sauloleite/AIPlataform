import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@aia/errors';
import { EVENT_TYPES, newEvent } from '@aia/messaging';
import {
  BUDGET_REPOSITORY,
  CLOCK,
  PROJECT_REPOSITORY,
  type BudgetRepository,
  type Clock,
  type ProjectRepository,
} from '../ports.js';
import type { ProjectPolicyView, SetPolicyCommand } from '../dto.js';
import { toPolicyView } from '../mappers.js';

const SOURCE = '/aia/governance';

@Injectable()
export class SetProjectPolicy {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(BUDGET_REPOSITORY) private readonly budgets: BudgetRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: SetPolicyCommand): Promise<ProjectPolicyView> {
    const project = await this.projects.findById(command.projectId);
    if (project === null) throw new NotFoundError('Projeto', command.projectId);

    const now = this.clock.now();

    if (command.allowedDataZones !== undefined)
      project.restrictZones(command.allowedDataZones, now);
    if (command.modelRules !== undefined) project.setModelRules(command.modelRules, now);
    if (command.maxConcurrentRequests !== undefined) {
      project.setMaxConcurrentRequests(command.maxConcurrentRequests, now);
    }
    if (command.contentCapture !== undefined)
      project.setContentCapture(command.contentCapture, now);

    await this.projects.save(project, [
      newEvent({
        type: EVENT_TYPES.POLICY_CHANGED,
        source: SOURCE,
        projectId: project.id,
        time: now,
        // O router escuta este evento para invalidar o cache local antes do TTL.
        data: { project_id: project.id, version: project.policyVersion },
      }),
    ]);

    return toPolicyView(project, await this.budgets.findByProject(command.projectId));
  }
}

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
 * Politica efetiva do projeto.
 *
 * Este e o endpoint mais chamado do servico: o inference-router o consulta a cada
 * requisicao, atraves de um cache local com TTL curto. Por isso ele nao faz
 * escrita e nao depende de nada alem dos dois repositorios.
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
    if (project === null) throw new NotFoundError('Projeto', projectId);

    const budget = await this.budgets.findByProject(projectId);
    // Orcamento de periodo vencido nao deve aparecer como gasto: o router
    // tomaria a decisao errada ate a virada ser persistida.
    if (budget?.isExpired(this.clock.now()) === true) {
      budget.rollOver(this.clock.now());
    }

    return toPolicyView(project, budget);
  }
}

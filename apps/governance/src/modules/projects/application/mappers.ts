import type { Budget } from '../domain/entities/budget.js';
import type { Project } from '../domain/entities/project.js';
import type { BudgetView, ProjectPolicyView, ProjectView } from './dto.js';

/** Traducoes de entidade para DTO. Ficam juntas para nao se espalharem. */

export function toProjectView(project: Project): ProjectView {
  const snapshot = project.toSnapshot();
  return {
    id: snapshot.id,
    slug: snapshot.slug,
    name: snapshot.name,
    ...(snapshot.description !== undefined && { description: snapshot.description }),
    dataClassification: snapshot.classification.level,
    legalBasis: snapshot.legalBasis,
    purpose: snapshot.purpose,
    ...(snapshot.costCenter !== undefined && { costCenter: snapshot.costCenter }),
    ...(snapshot.ownerPrincipalId !== undefined && { ownerPrincipalId: snapshot.ownerPrincipalId }),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

export function toBudgetView(budget: Budget): BudgetView {
  return {
    projectId: budget.projectId,
    currency: budget.limit.currency,
    limitMicros: Number(budget.limit.micros),
    spentMicros: Number(budget.spent.micros),
    reservedMicros: Number(budget.reserved.micros),
    period: budget.period,
    periodStart: budget.periodStart,
    periodEnd: budget.periodEnd(),
    blockAtLimit: budget.blockAtLimit,
    alertThresholds: [...budget.alertThresholds],
    usageRatio: budget.usageRatio(),
  };
}

export function toPolicyView(project: Project, budget: Budget | null): ProjectPolicyView {
  return {
    projectId: project.id,
    dataClassification: project.classification.level,
    allowedDataZones: [...project.allowedZones],
    modelRules: project.modelRules.map((rule) => ({ ...rule })),
    maxConcurrentRequests: project.maxConcurrentRequests,
    contentCapture: project.contentCapture,
    version: project.policyVersion,
    ...(budget !== null && {
      budget: {
        currency: budget.limit.currency,
        limitMicros: Number(budget.limit.micros),
        spentMicros: Number(budget.spent.micros),
        reservedMicros: Number(budget.reserved.micros),
        blockAtLimit: budget.blockAtLimit,
        periodEnd: budget.periodEnd(),
      },
    }),
  };
}

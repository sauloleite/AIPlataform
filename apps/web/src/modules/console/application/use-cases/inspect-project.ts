import { Money } from '../../domain/money';
import { classificationLabel, zonesFor, isClassification } from '../../domain/classification';
import type { ModelAliasSummary, PlatformGateway, PolicySnapshot } from '../ports';

export interface ProjectDetail {
  id: string;
  slug: string;
  name: string;
  description?: string;
  classification: string;
  classificationLabel: string;
  legalBasis?: string;
  purpose?: string;
  createdAt: string;

  budget?: {
    limitAmount: string;
    limit: string;
    spent: string;
    reserved?: string;
    remaining: string;
    ratio: number;
    period: 'daily' | 'monthly';
    periodEnd: string;
    blockAtLimit: boolean;
    currency: string;
  };

  policy?: PolicySnapshot;
  /**
   * Zones the classification allows but the policy has narrowed away. Showing
   * the difference is what makes "narrow, never widen" visible.
   */
  narrowedZones: string[];
  aliases: ModelAliasSummary[];
}

/**
 * Everything one project page needs, gathered on the server.
 *
 * Project, budget, policy and the alias catalogue live in three services. The
 * page renders them as one screen, so it fetches them as one unit: the browser
 * makes a single request and gets a complete page instead of assembling it
 * through four waterfalled calls.
 *
 * Budget, policy and aliases are optional in the result. Governance being
 * degraded is a state the platform is designed to survive, and the console
 * survives it too: what it could read, it shows.
 */
export class InspectProject {
  constructor(private readonly platform: PlatformGateway) {}

  async execute(accessToken: string, projectId: string): Promise<ProjectDetail> {
    const [project, budget, policy, aliases] = await Promise.all([
      this.platform.getProject(accessToken, projectId),
      optional(() => this.platform.getBudget(accessToken, projectId)),
      optional(() => this.platform.getPolicy(accessToken, projectId)),
      optional(() => this.platform.listModels(accessToken, projectId)),
    ]);

    const allowed = policy?.allowedDataZones ?? [];
    const maximum = isClassification(project.dataClassification)
      ? zonesFor(project.dataClassification)
      : [];

    const detail: ProjectDetail = {
      id: project.id,
      slug: project.slug,
      name: project.name,
      ...(project.description !== undefined && { description: project.description }),
      classification: project.dataClassification,
      classificationLabel: classificationLabel(project.dataClassification),
      ...(project.legalBasis !== undefined && { legalBasis: project.legalBasis }),
      ...(project.purpose !== undefined && { purpose: project.purpose }),
      createdAt: project.createdAt,
      ...(policy !== undefined && { policy }),
      narrowedZones: maximum.filter((zone) => !allowed.includes(zone)),
      aliases: aliases ?? [],
    };

    if (budget === undefined) return detail;

    const limit = Money.fromJson(budget.limit);
    const spent = Money.fromJson(budget.spent);
    const reserved = budget.reserved === undefined ? undefined : Money.fromJson(budget.reserved);

    return {
      ...detail,
      budget: {
        limitAmount: formatPlainAmount(limit),
        limit: limit.format(),
        spent: spent.format(),
        ...(reserved !== undefined && { reserved: reserved.format() }),
        remaining: limit.minus(spent).format(),
        ratio: spent.ratioOf(limit),
        period: budget.period,
        periodEnd: budget.periodEnd,
        blockAtLimit: budget.blockAtLimit,
        currency: limit.currency,
      },
    };
  }
}

/** The value for an editable field: digits only, so the form round-trips it. */
function formatPlainAmount(money: Money): string {
  return money.format().split(' ')[1] ?? '0.00';
}

async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

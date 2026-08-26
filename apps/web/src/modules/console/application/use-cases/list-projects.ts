import { Money } from '../../domain/money';
import { classificationLabel, isLocalOnly } from '../../domain/classification';
import type { PlatformGateway, ProjectSummary } from '../ports';

export interface ProjectCard {
  id: string;
  slug: string;
  name: string;
  description?: string;
  classification: string;
  classificationLabel: string;
  /** True when ADR-010 confines this project to the local model. */
  localOnly: boolean;
  budget?: {
    limit: string;
    spent: string;
    /** 0 to 1. A project with no limit reads as 0, never as full. */
    ratio: number;
    blockAtLimit: boolean;
  };
}

/**
 * The projects list, with each project's budget already resolved.
 *
 * The budget lives in a second endpoint, so a naive page would render the list
 * and then fire one request per row from the browser. Fetching them together on
 * the server turns N+1 round trips over the public network into N calls inside
 * the cluster, and the page arrives complete.
 *
 * A project whose budget cannot be read is still listed, without the budget: a
 * governance hiccup should not blank the whole page.
 */
export class ListProjects {
  constructor(private readonly platform: PlatformGateway) {}

  async execute(accessToken: string): Promise<ProjectCard[]> {
    const projects = await this.platform.listProjects(accessToken);

    const cards = await Promise.all(
      projects.map(async (project) => this.toCard(accessToken, project)),
    );
    return cards;
  }

  private async toCard(accessToken: string, project: ProjectSummary): Promise<ProjectCard> {
    const base: ProjectCard = {
      id: project.id,
      slug: project.slug,
      name: project.name,
      ...(project.description !== undefined && { description: project.description }),
      classification: project.dataClassification,
      classificationLabel: classificationLabel(project.dataClassification),
      localOnly: isLocalOnly(project.dataClassification),
    };

    try {
      const budget = await this.platform.getBudget(accessToken, project.id);
      const limit = Money.fromJson(budget.limit);
      const spent = Money.fromJson(budget.spent);

      return {
        ...base,
        budget: {
          limit: limit.format(),
          spent: spent.format(),
          ratio: spent.ratioOf(limit),
          blockAtLimit: budget.blockAtLimit,
        },
      };
    } catch {
      // No budget set yet, or governance is degraded. Either way the project
      // itself is still worth showing.
      return base;
    }
  }
}

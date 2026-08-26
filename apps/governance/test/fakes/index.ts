import type { CloudEvent } from '@aia/messaging';
import type {
  BudgetRepository,
  Clock,
  IdGenerator,
  ProjectRepository,
} from '../../src/modules/projects/application/ports.js';
import type { Budget } from '../../src/modules/projects/domain/entities/budget.js';
import type { Project } from '../../src/modules/projects/domain/entities/project.js';

export class FakeProjectRepository implements ProjectRepository {
  private readonly byId = new Map<string, Project>();
  readonly events: CloudEvent[] = [];

  async findById(id: string): Promise<Project | null> {
    return this.byId.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<Project | null> {
    for (const project of this.byId.values()) if (project.slug === slug) return project;
    return null;
  }

  async list(input: { limit: number }): Promise<{ items: Project[]; nextCursor: string | null }> {
    return { items: [...this.byId.values()].slice(0, input.limit), nextCursor: null };
  }

  async save(project: Project, events: CloudEvent[] = []): Promise<void> {
    this.byId.set(project.id, project);
    this.events.push(...events);
  }
}

export class FakeBudgetRepository implements BudgetRepository {
  private readonly byProject = new Map<string, Budget>();
  readonly events: CloudEvent[] = [];

  async findByProject(projectId: string): Promise<Budget | null> {
    return this.byProject.get(projectId) ?? null;
  }

  async save(budget: Budget, events: CloudEvent[] = []): Promise<void> {
    this.byProject.set(budget.projectId, budget);
    this.events.push(...events);
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  set(date: Date): void {
    this.current = date;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `proj-${this.counter.toString()}`;
  }
}

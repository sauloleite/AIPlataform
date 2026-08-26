import type { CloudEvent } from '@aia/messaging';
import type { Budget } from '../domain/entities/budget.js';
import type { Project } from '../domain/entities/project.js';

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  findBySlug(slug: string): Promise<Project | null>;
  list(input: { principalId?: string; limit: number; cursor?: string }): Promise<{
    items: Project[];
    nextCursor: string | null;
  }>;
  /** Saves the project and its events in the SAME transaction (outbox pattern). */
  save(project: Project, events?: CloudEvent[]): Promise<void>;
}
export const PROJECT_REPOSITORY = Symbol('ProjectRepository');

export interface BudgetRepository {
  findByProject(projectId: string): Promise<Budget | null>;
  save(budget: Budget, events?: CloudEvent[]): Promise<void>;
}
export const BUDGET_REPOSITORY = Symbol('BudgetRepository');

export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

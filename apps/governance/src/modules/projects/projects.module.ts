import { randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';
import { CreateProject } from './application/use-cases/create-project.js';
import { GetProjectPolicy } from './application/use-cases/get-project-policy.js';
import { SetBudget } from './application/use-cases/set-budget.js';
import { SetProjectPolicy } from './application/use-cases/set-project-policy.js';
import {
  BUDGET_REPOSITORY,
  CLOCK,
  ID_GENERATOR,
  PROJECT_REPOSITORY,
  type Clock,
  type IdGenerator,
} from './application/ports.js';
import { MongoBudgetRepository } from './infrastructure/mongo/budget.repository.js';
import { MongoProjectRepository } from './infrastructure/mongo/project.repository.js';
import { ProjectsController } from './presentation/http/projects.controller.js';

const adapters: Provider[] = [
  {
    provide: PROJECT_REPOSITORY,
    useFactory: (client: MongoClient, db: Db) => new MongoProjectRepository(client, db),
    inject: [MongoClient, Db],
  },
  {
    provide: BUDGET_REPOSITORY,
    useFactory: (client: MongoClient, db: Db) => new MongoBudgetRepository(client, db),
    inject: [MongoClient, Db],
  },
  { provide: ID_GENERATOR, useValue: { next: (): string => randomUUID() } satisfies IdGenerator },
  { provide: CLOCK, useValue: { now: (): Date => new Date() } satisfies Clock },
  {
    provide: HEALTH_CHECKS,
    useFactory: (db: Db, redis: Redis): DependencyCheck[] => [
      {
        name: 'mongodb',
        critical: true,
        check: async () => {
          await db.command({ ping: 1 });
          return { status: 'ok' as const };
        },
      },
      {
        name: 'redis',
        critical: false,
        check: async () => {
          await redis.ping();
          return { status: 'ok' as const };
        },
      },
    ],
    inject: [Db, Redis],
  },
];

@Module({
  controllers: [ProjectsController, HealthController],
  providers: [CreateProject, SetBudget, GetProjectPolicy, SetProjectPolicy, ...adapters],
})
export class ProjectsModule {}

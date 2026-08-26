import { randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { Db } from 'mongodb';
import { Redis } from 'ioredis';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';
import { Exemplo } from './application/use-cases/exemplo.js';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from './application/ports.js';
import { RegistryController } from './presentation/http/core.controller.js';

/** Wiring: o unico lugar que conhece as tres camadas ao mesmo tempo. */
const adapters: Provider[] = [
  { provide: CLOCK, useValue: { now: (): Date => new Date() } satisfies Clock },
  { provide: ID_GENERATOR, useValue: { next: (): string => randomUUID() } satisfies IdGenerator },
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
  controllers: [RegistryController, HealthController],
  providers: [Exemplo, ...adapters],
})
export class RegistryModule {}

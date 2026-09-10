import { randomUUID } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';

import { CONFIG, type RegistryConfig } from '../../config/index.js';
import {
  ASSET_REPOSITORY,
  CLOCK,
  ID_GENERATOR,
  REFERENCE_CHECKER,
  VERSION_REPOSITORY,
  type AssetRepository,
  type Clock,
  type IdGenerator,
  type ReferenceChecker,
  type VersionRepository,
} from './application/ports.js';
import { CreateAsset } from './application/use-cases/create-asset.js';
import { DeprecateVersion } from './application/use-cases/deprecate-version.js';
import { GetAsset } from './application/use-cases/get-asset.js';
import { GetPublishedVersion } from './application/use-cases/get-published-version.js';
import { ListAssets } from './application/use-cases/list-assets.js';
import { PublishVersion } from './application/use-cases/publish-version.js';
import { UpdateDraft } from './application/use-cases/update-draft.js';
import { HttpReferenceChecker } from './infrastructure/http/reference-checker.js';
import { MongoAssetRepository } from './infrastructure/mongo/asset.repository.js';
import { MongoVersionRepository } from './infrastructure/mongo/version.repository.js';
import { AssetsController } from './presentation/http/assets.controller.js';

/** Wiring: the only place that knows all three layers at once. */
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
      // Non-critical: the registry serves definitions from Mongo. Redis backs
      // the outbox relay, and a relay that is behind delays an event rather
      // than making a read wrong.
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
  {
    provide: ASSET_REPOSITORY,
    useFactory: (client: MongoClient, db: Db): AssetRepository =>
      new MongoAssetRepository(client, db),
    inject: [MongoClient, Db],
  },
  {
    provide: VERSION_REPOSITORY,
    useFactory: (db: Db): VersionRepository => new MongoVersionRepository(db),
    inject: [Db],
  },
  {
    // No service credential here: references are resolved as the caller, so the
    // registry never needs read access to projects it is not being asked about.
    provide: REFERENCE_CHECKER,
    useFactory: (config: RegistryConfig): ReferenceChecker =>
      new HttpReferenceChecker({
        routerUrl: config.INFERENCE_ROUTER_URL,
        knowledgeUrl: config.KNOWLEDGE_URL,
      }),
    inject: [CONFIG],
  },
];

const useCases: Provider[] = [
  {
    provide: CreateAsset,
    useFactory: (a: AssetRepository, v: VersionRepository, c: Clock, i: IdGenerator) =>
      new CreateAsset(a, v, c, i),
    inject: [ASSET_REPOSITORY, VERSION_REPOSITORY, CLOCK, ID_GENERATOR],
  },
  {
    provide: UpdateDraft,
    useFactory: (a: AssetRepository, v: VersionRepository, c: Clock) => new UpdateDraft(a, v, c),
    inject: [ASSET_REPOSITORY, VERSION_REPOSITORY, CLOCK],
  },
  {
    provide: PublishVersion,
    useFactory: (a: AssetRepository, v: VersionRepository, r: ReferenceChecker, c: Clock) =>
      new PublishVersion(a, v, r, c),
    inject: [ASSET_REPOSITORY, VERSION_REPOSITORY, REFERENCE_CHECKER, CLOCK],
  },
  {
    provide: DeprecateVersion,
    useFactory: (a: AssetRepository, v: VersionRepository, c: Clock) =>
      new DeprecateVersion(a, v, c),
    inject: [ASSET_REPOSITORY, VERSION_REPOSITORY, CLOCK],
  },
  {
    provide: ListAssets,
    useFactory: (a: AssetRepository) => new ListAssets(a),
    inject: [ASSET_REPOSITORY],
  },
  {
    provide: GetAsset,
    useFactory: (a: AssetRepository, v: VersionRepository) => new GetAsset(a, v),
    inject: [ASSET_REPOSITORY, VERSION_REPOSITORY],
  },
  {
    provide: GetPublishedVersion,
    useFactory: (a: AssetRepository, v: VersionRepository) => new GetPublishedVersion(a, v),
    inject: [ASSET_REPOSITORY, VERSION_REPOSITORY],
  },
];

@Module({
  controllers: [AssetsController, HealthController],
  providers: [...adapters, ...useCases],
  exports: [ASSET_REPOSITORY, VERSION_REPOSITORY],
})
export class AssetsModule {}

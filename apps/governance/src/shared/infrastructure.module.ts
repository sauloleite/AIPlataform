import { Global, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { JwtVerifier } from '@aia/auth';
import { JWT_VERIFIER } from '@aia/nest';
import { RedisStreamPublisher, type EventPublisher } from '@aia/messaging';
import { CONFIG, loadConfig, type GovernanceConfig } from '../config/index.js';

export const EVENT_PUBLISHER = Symbol('EventPublisher');

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): GovernanceConfig => loadConfig() },
    {
      provide: MongoClient,
      useFactory: async (config: GovernanceConfig): Promise<MongoClient> => {
        const client = new MongoClient(config.MONGO_URI, { serverSelectionTimeoutMS: 5_000 });
        await client.connect();
        return client;
      },
      inject: [CONFIG],
    },
    {
      provide: Db,
      useFactory: (client: MongoClient, config: GovernanceConfig): Db =>
        client.db(config.MONGO_DATABASE),
      inject: [MongoClient, CONFIG],
    },
    {
      provide: Redis,
      useFactory: (config: GovernanceConfig): Redis =>
        new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false }),
      inject: [CONFIG],
    },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (redis: Redis): EventPublisher => new RedisStreamPublisher(redis),
      inject: [Redis],
    },
    {
      provide: JWT_VERIFIER,
      useFactory: (config: GovernanceConfig): JwtVerifier =>
        new JwtVerifier({
          issuer: config.IDENTITY_ISSUER,
          jwksUri: config.IDENTITY_JWKS_URL ?? `${config.IDENTITY_ISSUER}/.well-known/jwks.json`,
          audience: config.IDENTITY_AUDIENCE,
        }),
      inject: [CONFIG],
    },
  ],
  exports: [CONFIG, MongoClient, Db, Redis, EVENT_PUBLISHER, JWT_VERIFIER],
})
export class InfrastructureModule implements OnApplicationShutdown {
  private readonly logger = new Logger(InfrastructureModule.name);

  constructor(
    private readonly mongo: MongoClient,
    private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('encerrando conexoes');
    await Promise.allSettled([this.mongo.close(), this.redis.quit()]);
  }
}

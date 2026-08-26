import { Global, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { JwtVerifier } from '@aia/auth';
import { JWT_VERIFIER } from '@aia/nest';
import { CONFIG, loadConfig, type IdentityConfig } from '../config/index.js';

/**
 * Shared connections. Global because one connection pool per module would
 * multiply sockets for no gain.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): IdentityConfig => loadConfig() },
    {
      provide: MongoClient,
      useFactory: async (config: IdentityConfig): Promise<MongoClient> => {
        const client = new MongoClient(config.MONGO_URI, {
          serverSelectionTimeoutMS: 5_000,
          retryWrites: true,
        });
        await client.connect();
        return client;
      },
      inject: [CONFIG],
    },
    {
      provide: Db,
      useFactory: (client: MongoClient, config: IdentityConfig): Db =>
        client.db(config.MONGO_DATABASE),
      inject: [MongoClient, CONFIG],
    },
    {
      provide: Redis,
      useFactory: (config: IdentityConfig): Redis =>
        new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: 2,
          // Keeps the cache from stalling the request path when Redis disappears.
          enableOfflineQueue: false,
          lazyConnect: false,
        }),
      inject: [CONFIG],
    },
    {
      provide: JWT_VERIFIER,
      useFactory: (config: IdentityConfig): JwtVerifier =>
        new JwtVerifier({
          issuer: config.IDENTITY_ISSUER,
          jwksUri: `${config.IDENTITY_ISSUER}/.well-known/jwks.json`,
          audience: config.IDENTITY_AUDIENCE,
        }),
      inject: [CONFIG],
    },
  ],
  exports: [CONFIG, MongoClient, Db, Redis, JWT_VERIFIER],
})
export class InfrastructureModule implements OnApplicationShutdown {
  private readonly logger = new Logger(InfrastructureModule.name);

  constructor(
    private readonly mongo: MongoClient,
    private readonly redis: Redis,
  ) {}

  /** Graceful shutdown: closes the pools so no connection is left hanging. */
  async onApplicationShutdown(): Promise<void> {
    this.logger.log('closing connections');
    await Promise.allSettled([this.mongo.close(), this.redis.quit()]);
  }
}

import { randomUUID, randomBytes } from 'node:crypto';
import { Module, type Provider } from '@nestjs/common';
import { Db } from 'mongodb';
import { Redis } from 'ioredis';
import { HEALTH_CHECKS, HealthController, type DependencyCheck } from '@aia/nest';
import { AuthenticateClient } from './application/use-cases/authenticate-client.js';
import { AuthenticateWithPassword } from './application/use-cases/authenticate-with-password.js';
import { CreatePat } from './application/use-cases/create-pat.js';
import { IntrospectToken } from './application/use-cases/introspect-token.js';
import {
  CLOCK,
  ID_GENERATOR,
  INTROSPECTION_CACHE,
  PASSWORD_HASHER,
  PAT_REPOSITORY,
  PRINCIPAL_REPOSITORY,
  SERVICE_CLIENT_REPOSITORY,
  TOKEN_HASHER,
  TOKEN_SIGNER,
  type Clock,
  type IdGenerator,
  type TokenHasher,
} from './application/ports.js';
import { Argon2PasswordHasher } from './infrastructure/crypto/argon2-password-hasher.js';
import { HmacTokenHasher } from './infrastructure/crypto/hmac-token-hasher.js';
import { JoseTokenSigner } from './infrastructure/crypto/jose-token-signer.js';
import { MongoSigningKeyStore } from './infrastructure/mongo/signing-key.store.js';
import { MongoPatRepository } from './infrastructure/mongo/pat.repository.js';
import { MongoPrincipalRepository } from './infrastructure/mongo/principal.repository.js';
import { MongoServiceClientRepository } from './infrastructure/mongo/service-client.repository.js';
import { RedisIntrospectionCache } from './infrastructure/redis/introspection-cache.js';
import { AuthController } from './presentation/http/auth.controller.js';
import { PatsController } from './presentation/http/pats.controller.js';
import { CONFIG, type IdentityConfig } from '../../config/index.js';

/**
 * Module wiring: the only place that knows domain, application and
 * infrastructure at once. The use cases still talk only to ports.
 */
const adapters: Provider[] = [
  { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
  {
    provide: TOKEN_HASHER,
    useFactory: (config: IdentityConfig) => new HmacTokenHasher(config.IDENTITY_TOKEN_PEPPER),
    inject: [CONFIG],
  },
  {
    provide: MongoSigningKeyStore,
    useFactory: (db: Db) => new MongoSigningKeyStore(db),
    inject: [Db],
  },
  {
    provide: TOKEN_SIGNER,
    useFactory: (config: IdentityConfig, keyStore: MongoSigningKeyStore) =>
      new JoseTokenSigner({
        issuer: config.IDENTITY_ISSUER,
        audience: config.IDENTITY_AUDIENCE,
        // A configured key wins (production). Without one, the key is generated
        // once and persisted, so a restart does not invalidate issued tokens.
        ...(config.IDENTITY_SIGNING_PRIVATE_KEY !== undefined
          ? {
              keys: [
                {
                  kid: config.IDENTITY_SIGNING_KID,
                  privateKeyPem: config.IDENTITY_SIGNING_PRIVATE_KEY,
                  ...(config.IDENTITY_SIGNING_PUBLIC_KEY !== undefined && {
                    publicKeyPem: config.IDENTITY_SIGNING_PUBLIC_KEY,
                  }),
                },
              ],
            }
          : { loadKeys: () => keyStore.loadOrCreate(config.IDENTITY_SIGNING_KID) }),
      }),
    inject: [CONFIG, MongoSigningKeyStore],
  },
  {
    provide: PRINCIPAL_REPOSITORY,
    useFactory: (db: Db) => new MongoPrincipalRepository(db),
    inject: [Db],
  },
  { provide: PAT_REPOSITORY, useFactory: (db: Db) => new MongoPatRepository(db), inject: [Db] },
  {
    provide: SERVICE_CLIENT_REPOSITORY,
    useFactory: (db: Db, hasher: TokenHasher) => new MongoServiceClientRepository(db, hasher),
    inject: [Db, TOKEN_HASHER],
  },
  {
    provide: INTROSPECTION_CACHE,
    useFactory: (redis: Redis) => new RedisIntrospectionCache(redis),
    inject: [Redis],
  },
  {
    provide: ID_GENERATOR,
    useValue: {
      next: (): string => randomUUID(),
      secret: (bytes: number): string => randomBytes(bytes).toString('base64url'),
    } satisfies IdGenerator,
  },
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
        // Without Redis, introspection loses its cache but stays correct.
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
  controllers: [AuthController, PatsController, HealthController],
  providers: [
    AuthenticateWithPassword,
    AuthenticateClient,
    CreatePat,
    IntrospectToken,
    ...adapters,
  ],
})
export class AuthModule {}

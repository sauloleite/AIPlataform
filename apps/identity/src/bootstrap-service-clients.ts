import { Logger, type INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { ServiceClient } from './modules/auth/domain/entities/service-client.js';
import { TokenScopes } from './modules/auth/domain/value-objects/token-scopes.js';
import {
  SERVICE_CLIENT_REPOSITORY,
  TOKEN_HASHER,
  type ServiceClientRepository,
  type TokenHasher,
} from './modules/auth/application/ports.js';
import { MongoServiceClientRepository } from './modules/auth/infrastructure/mongo/service-client.repository.js';
import type { IdentityConfig } from './config/index.js';

const schema = z.array(
  z.object({
    clientId: z.string().min(3),
    displayName: z.string().optional(),
    secret: z.string().min(16),
    scopes: z.array(z.string()).min(1),
  }),
);

/**
 * Registers the service clients declared in configuration.
 *
 * Idempotent, and it always rewrites the secret hash: rotating a service
 * credential is changing the environment variable and restarting, with no manual
 * step in between.
 */
export async function bootstrapServiceClients(
  app: INestApplication,
  config: IdentityConfig,
): Promise<void> {
  const logger = new Logger('bootstrap');
  const repository = app.get<ServiceClientRepository>(SERVICE_CLIENT_REPOSITORY);
  const hasher = app.get<TokenHasher>(TOKEN_HASHER);

  if (repository instanceof MongoServiceClientRepository) await repository.ensureIndexes();

  let entries: z.infer<typeof schema>;
  try {
    entries = schema.parse(JSON.parse(config.IDENTITY_BOOTSTRAP_SERVICE_CLIENTS));
  } catch (error) {
    // Malformed configuration must not pass silently: without a service client
    // the router cannot read policy and the platform stops.
    throw new Error(
      `Invalid IDENTITY_BOOTSTRAP_SERVICE_CLIENTS: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  for (const entry of entries) {
    const existing = await repository.findByClientId(entry.clientId);
    const secretHash = hasher.hash(entry.secret);

    if (existing === null) {
      await repository.save(
        ServiceClient.register({
          clientId: entry.clientId,
          displayName: entry.displayName ?? entry.clientId,
          secretHash,
          scopes: TokenScopes.of(entry.scopes),
        }),
      );
      logger.log(`service client registered: ${entry.clientId}`);
      continue;
    }

    existing.rotateSecret(secretHash);
    await repository.save(existing);
  }
}

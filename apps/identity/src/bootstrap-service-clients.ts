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
 * Registra os clientes de servico da configuracao.
 *
 * Idempotente e sempre reescreve o hash do segredo: rotacionar a credencial de
 * um servico e mudar a variavel de ambiente e reiniciar, sem passo manual.
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
    // Configuracao malformada nao pode passar silenciosamente: sem cliente de
    // servico, o router nao consegue ler politica e a plataforma para.
    throw new Error(
      `IDENTITY_BOOTSTRAP_SERVICE_CLIENTS invalido: ${
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
      logger.log(`cliente de servico registrado: ${entry.clientId}`);
      continue;
    }

    existing.rotateSecret(secretHash);
    await repository.save(existing);
  }
}

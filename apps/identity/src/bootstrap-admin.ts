import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ROLES } from '@aia/auth';
import { PrincipalEntity } from './modules/auth/domain/entities/principal.js';
import { Email } from './modules/auth/domain/value-objects/email.js';
import {
  PASSWORD_HASHER,
  PAT_REPOSITORY,
  PRINCIPAL_REPOSITORY,
  type PasswordHasher,
  type PatRepository,
  type PrincipalRepository,
} from './modules/auth/application/ports.js';
import { MongoPatRepository } from './modules/auth/infrastructure/mongo/pat.repository.js';
import { MongoPrincipalRepository } from './modules/auth/infrastructure/mongo/principal.repository.js';
import type { IdentityConfig } from './config/index.js';

/**
 * Cria indices e, se configurado, o primeiro administrador.
 *
 * Sem isso a plataforma nasce sem ninguem que possa criar um projeto. O admin so
 * e criado quando nao existe: reiniciar o servico nunca sobrescreve a senha.
 */
export async function bootstrapAdmin(app: INestApplication, config: IdentityConfig): Promise<void> {
  const logger = new Logger('bootstrap');
  const principals = app.get<PrincipalRepository>(PRINCIPAL_REPOSITORY);
  const hasher = app.get<PasswordHasher>(PASSWORD_HASHER);

  // Os indices sao criados a partir do adapter concreto; se o wiring trocar por
  // outro repositorio, esta etapa simplesmente nao se aplica.
  if (principals instanceof MongoPrincipalRepository) await principals.ensureIndexes();
  const pats = app.get<PatRepository>(PAT_REPOSITORY);
  if (pats instanceof MongoPatRepository) await pats.ensureIndexes();

  const email = config.IDENTITY_BOOTSTRAP_ADMIN_EMAIL;
  const password = config.IDENTITY_BOOTSTRAP_ADMIN_PASSWORD;
  if (email === undefined || password === undefined) return;

  const existing = await principals.findByEmail(Email.of(email));
  if (existing !== null) return;

  await principals.save(
    PrincipalEntity.createUser({
      id: randomUUID(),
      email: Email.of(email),
      displayName: 'Administrador',
      passwordHash: await hasher.hash(password),
      globalRoles: [ROLES.PLATFORM_ADMIN],
    }),
  );
  logger.warn(`administrador inicial criado para ${email}. Troque a senha no primeiro acesso.`);
}

import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';
// Import de TIPO: some na compilacao, entao nao antecipa nenhum modulo com I/O.
import type { ProjectRepository } from './modules/projects/application/ports.js';

startTelemetry({ serviceName: 'aia-governance' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { OutboxRelay, MongoOutbox } = await import('@aia/messaging');
const { Db } = await import('mongodb');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');
const { EVENT_PUBLISHER } = await import('./shared/infrastructure.module.js');
const { PROJECT_REPOSITORY } = await import('./modules/projects/application/ports.js');
const { MongoProjectRepository } =
  await import('./modules/projects/infrastructure/mongo/project.repository.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

const projects = app.get<ProjectRepository>(PROJECT_REPOSITORY);
if (projects instanceof MongoProjectRepository) await projects.ensureIndexes();

// O relay publica o que a outbox acumulou. Roda no proprio processo porque o
// volume de eventos de governanca e baixo; se crescer, vira um worker separado.
const relay = new OutboxRelay(new MongoOutbox(app.get(Db)), app.get(EVENT_PUBLISHER), {
  onError: (error, record) => {
    logger.warn(`falha ao publicar ${record.event.type}: ${String(error)}`);
  },
});
relay.start();
app.enableShutdownHooks();

await app.listen(config.PORT, '0.0.0.0');
logger.log(`aia-governance ouvindo na porta ${config.PORT.toString()}`);

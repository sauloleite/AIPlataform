import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';
// Import de TIPO: some na compilacao, entao nao antecipa nenhum modulo com I/O.
import type { AuditRepository, UsagePublisher } from './modules/completions/application/ports.js';

startTelemetry({ serviceName: 'aia-inference-router' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { MongoOutbox, OutboxRelay } = await import('@aia/messaging');
const { Db } = await import('mongodb');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');
const { EVENT_PUBLISHER } = await import('./shared/infrastructure.module.js');
const { AUDIT_REPOSITORY, USAGE_PUBLISHER } =
  await import('./modules/completions/application/ports.js');
const { MongoAuditRepository } =
  await import('./modules/completions/infrastructure/mongo/audit.repository.js');
const { OutboxUsagePublisher } =
  await import('./modules/completions/infrastructure/messaging/outbox-usage-publisher.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
  // Corpo maior que 1 MB indica prompt fora de escala; o limite protege memoria.
  bodyParser: true,
});

app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

const audit = app.get<AuditRepository>(AUDIT_REPOSITORY);
if (audit instanceof MongoAuditRepository) await audit.ensureIndexes();

const publisher = app.get<UsagePublisher>(USAGE_PUBLISHER);
if (publisher instanceof OutboxUsagePublisher) await publisher.ensureIndexes();

// Relay da outbox: leva os UsageRecorded gravados junto da auditoria para o
// barramento. Publicar direto no caminho da requisicao criaria duas fontes de
// verdade quando a publicacao falhasse.
const relay = new OutboxRelay(new MongoOutbox(app.get(Db)), app.get(EVENT_PUBLISHER), {
  batchSize: 200,
  intervalMs: 1_000,
  onError: (error, record) => {
    logger.warn(`falha ao publicar ${record.event.type}: ${String(error)}`);
  },
});
relay.start();

await app.listen(config.PORT, '0.0.0.0');
logger.log(`aia-inference-router ouvindo na porta ${config.PORT.toString()}`);

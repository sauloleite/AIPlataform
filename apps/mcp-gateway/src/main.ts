import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';

// Telemetry starts BEFORE any import that does I/O: auto-instrumentation has to
// wrap the modules at load time.
startTelemetry({ serviceName: 'aia-mcp-gateway' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { MongoOutbox, OutboxRelay } = await import('@aia/messaging');
const { Db } = await import('mongodb');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');
const { EVENT_PUBLISHER } = await import('./shared/infrastructure.module.js');
const { BINDING_REPOSITORY, AUDIT_REPOSITORY, CONNECTION_REPOSITORY } =
  await import('./modules/tools/application/ports.js');
const { MongoBindingRepository } =
  await import('./modules/tools/infrastructure/mongo/binding.repository.js');
const { MongoConnectionRepository } =
  await import('./modules/tools/infrastructure/mongo/connection.repository.js');
const { MongoAuditRepository } =
  await import('./modules/tools/infrastructure/mongo/audit.repository.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

const bindings: unknown = app.get(BINDING_REPOSITORY);
if (bindings instanceof MongoBindingRepository) await bindings.ensureIndexes();
const audit: unknown = app.get(AUDIT_REPOSITORY);
if (audit instanceof MongoAuditRepository) await audit.ensureIndexes();
const connections: unknown = app.get(CONNECTION_REPOSITORY);
if (connections instanceof MongoConnectionRepository) await connections.ensureIndexes();

// Outbox relay: carries the events written in the same transaction as the state
// to the bus. Without it the outbox is only half the pattern -- the events are
// recorded correctly and then never reach anybody.
const relay = new OutboxRelay(new MongoOutbox(app.get(Db)), app.get(EVENT_PUBLISHER), {
  batchSize: 200,
  intervalMs: 1_000,
  onError: (error, record) => {
    logger.warn(`could not publish ${record.event.type}: ${String(error)}`);
  },
});
relay.start();

await app.listen(config.PORT, '0.0.0.0');
logger.log(`aia-mcp-gateway listening on port ${config.PORT.toString()}`);

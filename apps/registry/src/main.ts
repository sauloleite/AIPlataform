import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';

// Telemetry starts BEFORE any import that does I/O: auto-instrumentation has to
// wrap the modules at load time.
startTelemetry({ serviceName: 'aia-registry' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { MongoOutbox, OutboxRelay } = await import('@aia/messaging');
const { Db } = await import('mongodb');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');
const { EVENT_PUBLISHER } = await import('./shared/infrastructure.module.js');
const { ASSET_REPOSITORY, VERSION_REPOSITORY } =
  await import('./modules/assets/application/ports.js');
const { MongoAssetRepository } =
  await import('./modules/assets/infrastructure/mongo/asset.repository.js');
const { MongoVersionRepository } =
  await import('./modules/assets/infrastructure/mongo/version.repository.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

// The API owns the schema. Two processes racing to create the same index is
// survivable but noisy, so one place does it.
const assets: unknown = app.get(ASSET_REPOSITORY);
if (assets instanceof MongoAssetRepository) await assets.ensureIndexes();
const versions: unknown = app.get(VERSION_REPOSITORY);
if (versions instanceof MongoVersionRepository) await versions.ensureIndexes();

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
logger.log(`aia-registry listening on port ${config.PORT.toString()}`);

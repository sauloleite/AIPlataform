import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';

// Telemetry starts BEFORE any import that does I/O: auto-instrumentation has to
// wrap the modules at load time.
startTelemetry({ serviceName: 'aia-knowledge' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { MongoOutbox, OutboxRelay } = await import('@aia/messaging');
const { Db } = await import('mongodb');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');
const { EVENT_PUBLISHER } = await import('./shared/infrastructure.module.js');
const {
  STORE_REPOSITORY,
  STORE_SUBSCRIPTION_REPOSITORY,
  DOCUMENT_REPOSITORY,
  CHUNK_REPOSITORY,
  OBJECT_STORE,
  KNOWLEDGE_BUCKET,
} = await import('./modules/stores/application/ports.js');
const { MongoStoreRepository } =
  await import('./modules/stores/infrastructure/mongo/store.repository.js');
const { MongoDocumentRepository } =
  await import('./modules/stores/infrastructure/mongo/document.repository.js');
const { MongoChunkRepository } =
  await import('./modules/stores/infrastructure/mongo/chunk.repository.js');
const { MongoStoreSubscriptionRepository } =
  await import('./modules/stores/infrastructure/mongo/store-subscription.repository.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

// The API owns the schema. The worker assumes it exists: two processes racing
// to create the same index is survivable but noisy, so one place does it.
const stores: unknown = app.get(STORE_REPOSITORY);
if (stores instanceof MongoStoreRepository) await stores.ensureIndexes();
const documents: unknown = app.get(DOCUMENT_REPOSITORY);
if (documents instanceof MongoDocumentRepository) await documents.ensureIndexes();
const chunks: unknown = app.get(CHUNK_REPOSITORY);
if (chunks instanceof MongoChunkRepository) await chunks.ensureIndexes();
const subscriptions: unknown = app.get(STORE_SUBSCRIPTION_REPOSITORY);
if (subscriptions instanceof MongoStoreSubscriptionRepository) {
  await subscriptions.ensureIndexes();
}
const objects: unknown = app.get(OBJECT_STORE);
if (objects !== null && typeof objects === 'object' && 'ensureBucket' in objects) {
  await (objects as { ensureBucket: (b: string) => Promise<void> }).ensureBucket(
    app.get<string>(KNOWLEDGE_BUCKET),
  );
}

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
logger.log(`aia-knowledge listening on port ${config.PORT.toString()}`);

import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';

// Type-only, so it is erased at compile time and runs no I/O before telemetry.
import type { IngestionJobPayload, ObjectStore } from './modules/stores/application/ports.js';

// Telemetry starts BEFORE any import that does I/O: auto-instrumentation has to
// wrap the modules at load time.
startTelemetry({ serviceName: 'aia-knowledge-worker' });

const { Logger } = await import('@nestjs/common');
const { NestFactory } = await import('@nestjs/core');
const { Worker } = await import('bullmq');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');
const { IngestDocument } =
  await import('./modules/stores/application/use-cases/ingest-document.js');
const { INGESTION_QUEUE_NAME } =
  await import('./modules/stores/infrastructure/queue/bullmq-queue.js');
const { OBJECT_STORE, KNOWLEDGE_BUCKET } = await import('./modules/stores/application/ports.js');

const config = loadConfig();
const logger = new Logger('worker');

// createApplicationContext, not create(): the same DI and the same validated
// configuration, but no HTTP listener. A worker that opens a port is a worker
// somebody eventually routes traffic to by accident.
const app = await NestFactory.createApplicationContext(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});
app.enableShutdownHooks();

const ingest = app.get(IngestDocument);
const objects = app.get<ObjectStore>(OBJECT_STORE);
await objects.ensureBucket(app.get<string>(KNOWLEDGE_BUCKET));

const worker = new Worker<IngestionJobPayload>(
  INGESTION_QUEUE_NAME,
  async (job) => {
    await ingest.execute(job.data);
  },
  {
    connection: { url: config.REDIS_URL },
    // Ingestion is I/O bound on the embedding call, so a few in flight helps;
    // beyond that the work just queues inside the router instead.
    concurrency: 4,
  },
);

worker.on('failed', (job, error) => {
  logger.error(`ingestion job ${job?.id ?? 'unknown'} failed: ${error.message}`);
});

logger.log('aia-knowledge worker listening for ingestion jobs');

const shutdown = async (): Promise<void> => {
  await worker.close();
  await app.close();
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

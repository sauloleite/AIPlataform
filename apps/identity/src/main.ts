import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';

// A telemetria sobe ANTES de qualquer import que faca I/O: a auto-instrumentacao
// precisa envolver os modulos no momento da carga.
startTelemetry({ serviceName: 'aia-identity' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');
const { bootstrapAdmin } = await import('./bootstrap-admin.js');
const { bootstrapServiceClients } = await import('./bootstrap-service-clients.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});

app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

await bootstrapAdmin(app, config);
await bootstrapServiceClients(app, config);

await app.listen(config.PORT, '0.0.0.0');
logger.log(`aia-identity ouvindo na porta ${config.PORT.toString()}`);

import 'reflect-metadata';
import { startTelemetry } from '@aia/telemetry';

// A telemetria sobe ANTES de qualquer import que faca I/O: a auto-instrumentacao
// precisa envolver os modulos no momento da carga.
startTelemetry({ serviceName: 'aia-registry' });

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('@nestjs/common');
const { ProblemDetailsFilter } = await import('@aia/nest');
const { AppModule } = await import('./app.module.js');
const { loadConfig } = await import('./config/index.js');

const config = loadConfig();
const logger = new Logger('bootstrap');

const app = await NestFactory.create(AppModule, {
  logger:
    config.LOG_LEVEL === 'debug' ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
});
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks();

await app.listen(config.PORT, '0.0.0.0');
logger.log(`aia-registry ouvindo na porta ${config.PORT.toString()}`);

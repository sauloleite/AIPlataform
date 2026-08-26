import { diag, DiagConsoleLogger, DiagLogLevel, metrics, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** Collector's OTLP HTTP endpoint. Without it telemetry stays in memory. */
  otlpEndpoint?: string;
  debug?: boolean;
}

let sdk: NodeSDK | undefined;

/**
 * Starts OpenTelemetry. Call this before any import that performs I/O, because
 * auto-instrumentation has to wrap those modules as they load.
 *
 * The destination is an OTLP collector; which backend receives the data (Tempo,
 * Jaeger, a managed service) is a deployment decision, not a code one (ADR-009).
 */
export function startTelemetry(options: TelemetryOptions): void {
  if (sdk !== undefined) return;

  if (options.debug === true) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const endpoint = options.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        options.environment ?? process.env['NODE_ENV'] ?? 'development',
    }),
    traceExporter:
      endpoint === undefined ? undefined : new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader:
      endpoint === undefined
        ? undefined
        : new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
            exportIntervalMillis: 15_000,
          }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noise with no operational value.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

/** Shuts the SDK down, flushing anything not yet exported (graceful shutdown). */
export async function stopTelemetry(): Promise<void> {
  if (sdk === undefined) return;
  await sdk.shutdown();
  sdk = undefined;
}

export function getTracer(name: string, version?: string): ReturnType<typeof trace.getTracer> {
  return trace.getTracer(name, version);
}

export function getMeter(name: string, version?: string): ReturnType<typeof metrics.getMeter> {
  return metrics.getMeter(name, version);
}

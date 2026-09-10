import type { Attributes, Counter, Histogram } from '@opentelemetry/api';
import { AIA_ATTR, AIA_METRIC, GEN_AI_ATTR } from './attributes.js';
import { getMeter } from './bootstrap.js';

/**
 * The instruments behind `AIA_METRIC`.
 *
 * The six names were declared and nothing created an instrument for any of
 * them, so every SLI in reference doc 02 §11 -- TTFT p95, cost per project,
 * circuit state -- existed only as a field on an event or a line in a log. A
 * dashboard cannot be built on those: answering "what is the p95 this hour"
 * from an audit collection means a scan per panel refresh.
 *
 * They live in one module rather than in the services that record them so the
 * NAMES cannot drift. A metric renamed in one service and not another does not
 * fail anywhere; it silently splits one series into two, and the dashboard
 * shows half the traffic.
 */

/**
 * Attributes carried on the inference measurements.
 *
 * Deliberately NOT the principal: a metric's cost is the product of its label
 * cardinalities, and one series per user per alias per provider is how a
 * metrics backend falls over. The principal is on the span and in the audit,
 * which is where a question about one person belongs. Project is the exception
 * that earns its cardinality -- showback is the whole reason this is measured.
 */
export interface InferenceLabels {
  projectId: string;
  alias: string;
  provider: string;
  dataZone: string;
  status: 'completed' | 'failed' | 'partial';
}

export interface InferenceMeasurement extends InferenceLabels {
  durationMs: number;
  /** Absent on a non-streamed call, which has no such moment. */
  timeToFirstTokenMs?: number;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

interface Instruments {
  timeToFirstToken: Histogram;
  duration: Histogram;
  tokens: Counter;
  cost: Counter;
  budgetRejections: Counter;
  circuitStateChanges: Counter;
}

let instruments: Instruments | undefined;

/**
 * Created on first use, not at import.
 *
 * A meter taken at module load belongs to whatever provider existed then, and
 * `startTelemetry` runs from a service's entry point -- so an instrument built
 * during an import would record into the default no-op provider forever.
 */
function ensure(): Instruments {
  if (instruments !== undefined) return instruments;
  const meter = getMeter('@aia/telemetry');

  instruments = {
    timeToFirstToken: meter.createHistogram(AIA_METRIC.TIME_TO_FIRST_TOKEN, {
      description: 'Time until the first token of a streamed answer',
      unit: 'ms',
    }),
    duration: meter.createHistogram(AIA_METRIC.INFERENCE_DURATION, {
      description: 'Wall-clock duration of an inference call',
      unit: 'ms',
    }),
    tokens: meter.createCounter(AIA_METRIC.TOKENS_USED, {
      description: 'Tokens consumed, counted separately for input and output',
      unit: '{token}',
    }),
    cost: meter.createCounter(AIA_METRIC.COST_MICROS, {
      description: 'Cost committed against a project budget',
      unit: '{micro}',
    }),
    budgetRejections: meter.createCounter(AIA_METRIC.BUDGET_REJECTIONS, {
      description: 'Requests refused because a project had spent its budget',
      unit: '{request}',
    }),
    circuitStateChanges: meter.createCounter(AIA_METRIC.CIRCUIT_STATE_CHANGES, {
      description: 'Circuit breaker transitions, by deployment',
      unit: '{transition}',
    }),
  };
  return instruments;
}

/**
 * Labels that exist only on metrics, and are therefore not in `AIA_ATTR`.
 *
 * That catalogue is the set of SPAN attributes both languages must agree on
 * character for character, and a parity test compares them. Putting a
 * metric-only label there would oblige Python to declare a name it has no
 * instrument to use.
 */
const METRIC_LABEL = {
  STATUS: 'aia.status',
  TOKEN_TYPE: 'gen_ai.token.type',
  CIRCUIT_FROM: 'aia.circuit.from',
  CIRCUIT_TO: 'aia.circuit.to',
} as const;

function labelsOf(labels: InferenceLabels): Attributes {
  return {
    [AIA_ATTR.PROJECT_ID]: labels.projectId,
    [AIA_ATTR.ALIAS]: labels.alias,
    [GEN_AI_ATTR.PROVIDER_NAME]: labels.provider,
    [AIA_ATTR.DATA_ZONE]: labels.dataZone,
    [METRIC_LABEL.STATUS]: labels.status,
  };
}

/** One call's worth of measurements, recorded together so they share labels. */
export function recordInference(measurement: InferenceMeasurement): void {
  const { timeToFirstToken, duration, tokens, cost } = ensure();
  const labels = labelsOf(measurement);

  duration.record(measurement.durationMs, labels);
  if (measurement.timeToFirstTokenMs !== undefined) {
    timeToFirstToken.record(measurement.timeToFirstTokenMs, labels);
  }
  // Input and output are separate series rather than a sum: they cost different
  // amounts, and a rise in one means something quite different from a rise in
  // the other.
  tokens.add(measurement.promptTokens, { ...labels, [METRIC_LABEL.TOKEN_TYPE]: 'input' });
  tokens.add(measurement.completionTokens, { ...labels, [METRIC_LABEL.TOKEN_TYPE]: 'output' });
  cost.add(measurement.costMicros, labels);
}

/**
 * A request refused because the project had spent its budget.
 *
 * Counted apart from the failures, because it is not one: the platform worked
 * exactly as intended. A budget rejection rate that climbs is a conversation
 * with a customer, and an error rate that climbs is an incident.
 */
export function recordBudgetRejection(labels: { projectId: string; alias: string }): void {
  ensure().budgetRejections.add(1, {
    [AIA_ATTR.PROJECT_ID]: labels.projectId,
    [AIA_ATTR.ALIAS]: labels.alias,
  });
}

/** A circuit breaker opening or closing, by deployment. */
export function recordCircuitStateChange(change: { key: string; from: string; to: string }): void {
  ensure().circuitStateChanges.add(1, {
    [AIA_ATTR.DEPLOYMENT_ID]: change.key,
    [METRIC_LABEL.CIRCUIT_FROM]: change.from,
    [METRIC_LABEL.CIRCUIT_TO]: change.to,
  });
}

/** Drops the instruments, so a test can install a fresh meter provider. */
export function resetInstruments(): void {
  instruments = undefined;
}

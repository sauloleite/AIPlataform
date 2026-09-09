import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { AIA_ATTR } from './attributes.js';

/** Business identity that follows a request end to end. */
export interface BusinessContext {
  projectId: string;
  principalId?: string;
  principalType?: 'user' | 'application' | 'service';
  alias?: string;
  dataClassification?: string;
}

export function businessAttributes(context: BusinessContext): Attributes {
  const attributes: Attributes = { [AIA_ATTR.PROJECT_ID]: context.projectId };
  if (context.principalId) attributes[AIA_ATTR.PRINCIPAL_ID] = context.principalId;
  if (context.principalType) attributes[AIA_ATTR.PRINCIPAL_TYPE] = context.principalType;
  if (context.alias) attributes[AIA_ATTR.ALIAS] = context.alias;
  if (context.dataClassification) {
    attributes[AIA_ATTR.DATA_CLASSIFICATION] = context.dataClassification;
  }
  return attributes;
}

/** Attaches the business attributes to the active span. */
export function annotateActiveSpan(context: BusinessContext): void {
  trace.getActiveSpan()?.setAttributes(businessAttributes(context));
}

/**
 * What the platform DECIDED about a request, as against who made it.
 *
 * Separate from `BusinessContext` because these are not identity: a project id
 * is true before the request runs, whereas whether the budget could be verified
 * is only known while it does. Every field here was already computed, returned
 * to the caller and written to the audit -- and reached no span, so the one
 * place you would go to ask "how often did we serve on a stale policy last
 * week" could not answer.
 */
export interface RequestOutcome {
  cacheHit?: boolean;
  policyStale?: boolean;
  budgetUnverified?: boolean;
  guardrailsUnverified?: boolean;
  budgetReservedMicros?: number;
  budgetCommittedMicros?: number;
}

export function outcomeAttributes(outcome: RequestOutcome): Attributes {
  const attributes: Attributes = {};
  // Explicit `!== undefined`: `false` and `0` are answers, and a truthiness
  // check would drop exactly the readings that say nothing went wrong -- which
  // is what a rate is computed against.
  if (outcome.cacheHit !== undefined) attributes[AIA_ATTR.CACHE_HIT] = outcome.cacheHit;
  if (outcome.policyStale !== undefined) attributes[AIA_ATTR.POLICY_STALE] = outcome.policyStale;
  if (outcome.budgetUnverified !== undefined) {
    attributes[AIA_ATTR.BUDGET_UNVERIFIED] = outcome.budgetUnverified;
  }
  if (outcome.guardrailsUnverified !== undefined) {
    attributes[AIA_ATTR.GUARDRAILS_UNVERIFIED] = outcome.guardrailsUnverified;
  }
  if (outcome.budgetReservedMicros !== undefined) {
    attributes[AIA_ATTR.BUDGET_RESERVED_MICROS] = outcome.budgetReservedMicros;
  }
  if (outcome.budgetCommittedMicros !== undefined) {
    attributes[AIA_ATTR.BUDGET_COMMITTED_MICROS] = outcome.budgetCommittedMicros;
  }
  return attributes;
}

/** Attaches what was decided to the active span. */
export function annotateOutcome(outcome: RequestOutcome): void {
  trace.getActiveSpan()?.setAttributes(outcomeAttributes(outcome));
}

/** trace_id of the active span, to correlate Problem Details with telemetry. */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && spanContext.traceId !== '' ? spanContext.traceId : undefined;
}

/** Marks the span as failed, recording the stable code from the catalogue. */
export function recordSpanError(span: Span, error: unknown, code?: string): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof Error) span.recordException(error);
  if (code !== undefined) span.setAttribute(AIA_ATTR.ERROR_CODE, code);
}

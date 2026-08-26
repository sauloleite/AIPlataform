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

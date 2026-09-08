import { ValidationError } from '@aia/errors';

/**
 * CloudEvents 1.0 envelope (reference doc 02 §5 and doc 03 §6).
 *
 * `subject` always carries the `project_id`: the tenant follows the event
 * through the whole pipeline, all the way to analytics. `traceparent` carries
 * the trace context across the asynchronous boundary, which would otherwise
 * break the trace.
 */
export interface CloudEvent<T = unknown> {
  specversion: '1.0';
  /** E.g. `aia.inference.usage.recorded.v1`. A breaking change creates a new type. */
  type: string;
  /** Producer URI. E.g. `/aia/inference-router`. */
  source: string;
  id: string;
  time: string;
  /** `project_id`. Required by this platform even though the spec makes it optional. */
  subject: string;
  datacontenttype: 'application/json';
  data: T;
  /** Extension: W3C trace context. */
  traceparent?: string;
  /** Extension: deduplication key for idempotent consumers. */
  idempotencykey?: string;
}

export interface NewEventInput<T> {
  type: string;
  source: string;
  projectId: string;
  data: T;
  traceparent?: string;
  idempotencyKey?: string;
  /** Injectable so the event is deterministic in tests. */
  id?: string;
  time?: Date;
}

const TYPE_PATTERN = /^aia\.[a-z0-9]+(\.[a-z0-9_]+)+\.v\d+$/;

export function newEvent<T>(input: NewEventInput<T>): CloudEvent<T> {
  if (!TYPE_PATTERN.test(input.type)) {
    throw new ValidationError('event type must follow aia.<domain>.<fact>.v<N>', {
      type: input.type,
    });
  }
  if (input.projectId === '') {
    throw new ValidationError('projectId is required: project is the platform tenant');
  }

  return {
    specversion: '1.0',
    type: input.type,
    source: input.source,
    id: input.id ?? crypto.randomUUID(),
    time: (input.time ?? new Date()).toISOString(),
    subject: input.projectId,
    datacontenttype: 'application/json',
    data: input.data,
    ...(input.traceparent !== undefined && { traceparent: input.traceparent }),
    ...(input.idempotencyKey !== undefined && { idempotencykey: input.idempotencyKey }),
  };
}

/** Event types the platform publishes. One place, so typos cannot happen. */
export const EVENT_TYPES = {
  USAGE_RECORDED: 'aia.inference.usage.recorded.v1',
  PROJECT_CREATED: 'aia.governance.project.created.v1',
  BUDGET_CHANGED: 'aia.governance.budget.changed.v1',
  POLICY_CHANGED: 'aia.governance.policy.changed.v1',
  // Declared, not yet published: aia-identity emits no event today. It stays
  // here so the name is decided once rather than invented at the call site.
  PRINCIPAL_CHANGED: 'aia.identity.principal.changed.v1',
  ASSET_PUBLISHED: 'aia.registry.asset.published.v1',
  ASSET_DEPRECATED: 'aia.registry.asset.deprecated.v1',
  AGENT_RUN_FINISHED: 'aia.agent.run.finished.v1',
  APPROVAL_REQUESTED: 'aia.agent.approval.requested.v1',
  TOOL_INVOKED: 'aia.tools.tool.invoked.v1',
  DOCUMENT_INGESTED: 'aia.knowledge.document.ingested.v1',
  INGESTION_FAILED: 'aia.knowledge.ingestion.failed.v1',
  // Declared, not yet published: aia-document-processing does not exist yet
  // (roadmap M7). aia-knowledge parses text inline until it does.
  DOCUMENT_PARSED: 'aia.documents.document.parsed.v1',
  EVALUATION_FINISHED: 'aia.evaluation.run.finished.v1',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

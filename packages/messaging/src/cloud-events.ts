import { ValidationError } from '@aia/errors';

/**
 * Envelope CloudEvents 1.0 (doc 02, secao 5 e doc 03, secao 6).
 *
 * `subject` carrega sempre o `project_id`: o tenant acompanha o evento por todo
 * o pipeline, ate o analitico. `traceparent` propaga o contexto de trace atraves
 * da fronteira assincrona, que de outro modo quebraria o trace.
 */
export interface CloudEvent<T = unknown> {
  specversion: '1.0';
  /** Ex.: `aia.inference.usage.recorded.v1`. Mudanca incompativel cria novo type. */
  type: string;
  /** URI do produtor. Ex.: `/aia/inference-router`. */
  source: string;
  id: string;
  time: string;
  /** `project_id`. Obrigatorio na plataforma, ainda que opcional na spec. */
  subject: string;
  datacontenttype: 'application/json';
  data: T;
  /** Extensao: contexto de trace do W3C. */
  traceparent?: string;
  /** Extensao: chave de deduplicacao para consumidores idempotentes. */
  idempotencykey?: string;
}

export interface NewEventInput<T> {
  type: string;
  source: string;
  projectId: string;
  data: T;
  traceparent?: string;
  idempotencyKey?: string;
  /** Injetavel para tornar o evento deterministico em teste. */
  id?: string;
  time?: Date;
}

const TYPE_PATTERN = /^aia\.[a-z0-9]+(\.[a-z0-9_]+)+\.v\d+$/;

export function newEvent<T>(input: NewEventInput<T>): CloudEvent<T> {
  if (!TYPE_PATTERN.test(input.type)) {
    throw new ValidationError('type do evento deve seguir aia.<dominio>.<fato>.v<N>', {
      type: input.type,
    });
  }
  if (input.projectId === '') {
    throw new ValidationError('projectId e obrigatorio: projeto e o tenant da plataforma');
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

/** Tipos de evento publicados pela plataforma. Um lugar so, para evitar typo. */
export const EVENT_TYPES = {
  USAGE_RECORDED: 'aia.inference.usage.recorded.v1',
  PROJECT_CREATED: 'aia.governance.project.created.v1',
  BUDGET_CHANGED: 'aia.governance.budget.changed.v1',
  POLICY_CHANGED: 'aia.governance.policy.changed.v1',
  PRINCIPAL_CHANGED: 'aia.identity.principal.changed.v1',
  AGENT_RUN_FINISHED: 'aia.agent.run.finished.v1',
  APPROVAL_REQUESTED: 'aia.agent.approval.requested.v1',
  TOOL_INVOKED: 'aia.tools.tool.invoked.v1',
  DOCUMENT_INGESTED: 'aia.knowledge.document.ingested.v1',
  INGESTION_FAILED: 'aia.knowledge.ingestion.failed.v1',
  DOCUMENT_PARSED: 'aia.documents.document.parsed.v1',
  EVALUATION_FINISHED: 'aia.evaluation.run.finished.v1',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

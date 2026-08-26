import { ERROR_CODES, type ErrorCode, problemTypeFor } from './catalog.js';
import { type DomainError, InternalError, isDomainError } from './domain-error.js';

/**
 * Problem Details for HTTP APIs (RFC 9457).
 *
 * Extensoes da plataforma: `code` (estavel, do catalogo), `trace_id` (correlacao)
 * e os `details` do erro de dominio. Nenhum campo carrega PII.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  trace_id?: string;
  retry_after?: number;
  [extension: string]: unknown;
}

export interface ProblemContext {
  /** Caminho da requisicao, para o campo `instance`. */
  instance?: string;
  /** trace_id do W3C traceparent, para correlacionar com a telemetria. */
  traceId?: string;
}

const TITLES: Record<string, string> = {
  [ERROR_CODES.BUDGET_EXHAUSTED]: 'Orcamento do projeto esgotado',
  [ERROR_CODES.QUOTA_EXCEEDED]: 'Cota excedida',
  [ERROR_CODES.CONCURRENCY_LIMIT]: 'Limite de concorrencia do projeto atingido',
  [ERROR_CODES.NO_COMPATIBLE_DEPLOYMENT]:
    'Nenhum deployment compativel com a classificacao do projeto',
  [ERROR_CODES.ALIAS_NOT_FOUND]: 'Alias de modelo desconhecido',
  [ERROR_CODES.PROVIDER_UNAVAILABLE]: 'Provedor de modelo indisponivel',
  [ERROR_CODES.ALL_DEPLOYMENTS_FAILED]: 'Todos os deployments do alias falharam',
  [ERROR_CODES.STREAM_INTERRUPTED]: 'Stream interrompido',
  [ERROR_CODES.GUARDRAIL_BLOCKED]: 'Conteudo bloqueado por guardrail',
  [ERROR_CODES.PROMPT_INJECTION_SUSPECTED]: 'Suspeita de injecao de prompt',
  [ERROR_CODES.UNAUTHENTICATED]: 'Nao autenticado',
  [ERROR_CODES.FORBIDDEN]: 'Acesso negado',
  [ERROR_CODES.TOKEN_EXPIRED]: 'Token expirado',
  [ERROR_CODES.INVALID_TOKEN]: 'Token invalido',
  [ERROR_CODES.PROJECT_REQUIRED]: 'Projeto obrigatorio',
  [ERROR_CODES.PROJECT_NOT_FOUND]: 'Projeto nao encontrado',
  [ERROR_CODES.VALIDATION_FAILED]: 'Requisicao invalida',
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: 'Conflito de idempotencia',
  [ERROR_CODES.NOT_FOUND]: 'Recurso nao encontrado',
  [ERROR_CODES.CONFLICT]: 'Conflito de estado',
  [ERROR_CODES.UPSTREAM_TIMEOUT]: 'Tempo esgotado em dependencia',
  [ERROR_CODES.CIRCUIT_OPEN]: 'Dependencia em circuito aberto',
  [ERROR_CODES.INTERNAL_ERROR]: 'Erro interno',
};

export function titleFor(code: ErrorCode): string {
  return TITLES[code] ?? 'Erro';
}

/** Traduz um erro de dominio para o corpo de resposta em Problem Details. */
export function toProblemDetails(error: DomainError, context: ProblemContext = {}): ProblemDetails {
  const problem: ProblemDetails = {
    type: problemTypeFor(error.code),
    title: titleFor(error.code),
    status: error.status,
    detail: error.message,
    code: error.code,
    ...error.details,
  };

  if (context.instance !== undefined) problem.instance = context.instance;
  if (context.traceId !== undefined) problem.trace_id = context.traceId;

  const retryAfter = error.details['retry_after'];
  if (typeof retryAfter === 'number') problem.retry_after = retryAfter;

  return problem;
}

/**
 * Converte qualquer coisa lancada em Problem Details.
 *
 * Erro desconhecido vira 500 sem detalhe: mensagem interna nunca vaza para o cliente
 * (o stack vai para o log estruturado, correlacionado pelo trace_id).
 */
export function fromUnknown(error: unknown, context: ProblemContext = {}): ProblemDetails {
  if (isDomainError(error)) return toProblemDetails(error, context);
  return toProblemDetails(new InternalError(), context);
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

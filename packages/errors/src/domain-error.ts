import { ERROR_CODES, type ErrorCode } from './catalog.js';

/**
 * Detalhes adicionais carregados por um erro de dominio.
 * Viram extensoes do Problem Details, entao precisam ser serializaveis e sem PII.
 */
export type ErrorDetails = Record<string, string | number | boolean | null | string[] | number[]>;

/**
 * Raiz de toda excecao de negocio.
 *
 * O dominio lanca subclasses tipadas; a camada de apresentacao traduz para
 * Problem Details (doc 03, secao 5). Nunca retorne `null` para indicar erro.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  /** Status HTTP sugerido. A apresentacao pode sobrepor, mas raramente deve. */
  abstract readonly status: number;
  /** Se `true`, o cliente pode tentar de novo sem mudar a requisicao. */
  readonly retryable: boolean = false;
  readonly details: ErrorDetails;

  protected constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    // `captureStackTrace` so existe em V8; os tipos do Node o declaram como
    // sempre presente, entao a checagem opcional parece redundante e nao e.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Erro que nao mapeia para nenhuma regra de negocio conhecida. */
export class InternalError extends DomainError {
  readonly code = ERROR_CODES.INTERNAL_ERROR;
  readonly status = 500;

  constructor(message = 'Erro interno', details?: ErrorDetails) {
    super(message, details);
  }
}

export class ValidationError extends DomainError {
  readonly code = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details);
  }
}

export class NotFoundError extends DomainError {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly status = 404;

  constructor(resource: string, id: string) {
    super(`${resource} nao encontrado`, { resource, id });
  }
}

export class ConflictError extends DomainError {
  readonly code = ERROR_CODES.CONFLICT;
  readonly status = 409;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details);
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = ERROR_CODES.UNAUTHENTICATED;
  readonly status = 401;

  constructor(message = 'Credencial ausente ou invalida', details?: ErrorDetails) {
    super(message, details);
  }
}

export class ForbiddenError extends DomainError {
  readonly code = ERROR_CODES.FORBIDDEN;
  readonly status = 403;

  constructor(message: string, details?: ErrorDetails) {
    super(message, details);
  }
}

export class ProjectRequiredError extends DomainError {
  readonly code = ERROR_CODES.PROJECT_REQUIRED;
  readonly status = 400;

  constructor() {
    super('O header X-Project-Id e obrigatorio: projeto e o tenant da plataforma');
  }
}

export class UpstreamTimeoutError extends DomainError {
  readonly code = ERROR_CODES.UPSTREAM_TIMEOUT;
  readonly status = 504;
  override readonly retryable = true;

  constructor(target: string, timeoutMs: number) {
    super(`Tempo esgotado ao chamar ${target}`, { target, timeout_ms: timeoutMs });
  }
}

export class CircuitOpenError extends DomainError {
  readonly code = ERROR_CODES.CIRCUIT_OPEN;
  readonly status = 503;
  override readonly retryable = true;

  constructor(target: string, reopensInMs: number) {
    super(`Circuito aberto para ${target}`, { target, reopens_in_ms: reopensInMs });
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

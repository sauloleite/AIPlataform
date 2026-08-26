import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';
import type { DataClassification, DataZone } from '../value-objects/index.js';

export class BudgetExhaustedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.BUDGET_EXHAUSTED;
  readonly status = 429;
  override readonly retryable = true;

  constructor(projectId: string, retryAfterSeconds: number) {
    super('Orcamento do projeto esgotado no periodo', {
      project_id: projectId,
      retry_after: retryAfterSeconds,
    });
  }
}

/**
 * ADR-010: nao ha deployment cuja zona de dados seja compativel com a
 * classificacao do projeto. Falhar aqui e o comportamento correto — enviar o
 * dado assim mesmo seria a violacao.
 */
export class NoCompatibleDeploymentError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.NO_COMPATIBLE_DEPLOYMENT;
  readonly status = 422;

  constructor(input: {
    alias: string;
    classification: DataClassification;
    allowedZones: readonly DataZone[];
    availableZones: readonly DataZone[];
  }) {
    super(
      `Nenhum deployment de "${input.alias}" atende a classificacao "${input.classification}"`,
      {
        alias: input.alias,
        data_classification: input.classification,
        allowed_zones: [...input.allowedZones],
        available_zones: [...input.availableZones],
      },
    );
  }
}

export class AliasNotFoundError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.ALIAS_NOT_FOUND;
  readonly status = 404;

  constructor(alias: string) {
    super(`Alias de modelo "${alias}" nao existe no catalogo`, { alias });
  }
}

export class AliasNotAllowedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.FORBIDDEN;
  readonly status = 403;

  constructor(alias: string, projectId: string) {
    super(`A politica do projeto proibe o alias "${alias}"`, { alias, project_id: projectId });
  }
}

export class CapabilityNotSupportedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(alias: string, capability: string) {
    super(`O alias "${alias}" nao suporta ${capability}`, { alias, capability });
  }
}

/** Todos os deployments compativeis foram tentados e falharam. */
export class AllDeploymentsFailedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.ALL_DEPLOYMENTS_FAILED;
  readonly status = 503;
  override readonly retryable = true;

  constructor(alias: string, attempts: number, lastError: string) {
    super(`Todos os ${attempts.toString()} deployments de "${alias}" falharam`, {
      alias,
      attempts,
      last_error: lastError,
      retry_after: 5,
    });
  }
}

/**
 * O stream caiu depois do primeiro token.
 *
 * Nao ha retentativa possivel: o cliente ja recebeu parte da resposta, e repetir
 * geraria conteudo duplicado. O consumo parcial e comitado e marcado.
 */
export class StreamInterruptedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.STREAM_INTERRUPTED;
  readonly status = 500;

  constructor(reason: string, tokensEmitted: number) {
    super('O stream foi interrompido depois do primeiro token', {
      reason,
      tokens_emitted: tokensEmitted,
    });
  }
}

export class GuardrailBlockedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.GUARDRAIL_BLOCKED;
  readonly status = 400;

  constructor(rule: string, detail: string) {
    super(detail, { rule });
  }
}

export class PromptInjectionSuspectedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.PROMPT_INJECTION_SUSPECTED;
  readonly status = 400;

  constructor(signals: string[], score: number) {
    super('Conteudo com indicios de injecao de prompt', { signals, score });
  }
}

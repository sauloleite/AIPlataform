import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';
import type { DataClassification, DataZone } from '../value-objects/index.js';

export class BudgetExhaustedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.BUDGET_EXHAUSTED;
  readonly status = 429;
  override readonly retryable = true;

  constructor(projectId: string, retryAfterSeconds: number) {
    super('Project budget exhausted for the period', {
      project_id: projectId,
      retry_after: retryAfterSeconds,
    });
  }
}

/**
 * ADR-010: no deployment has a data zone compatible with the project's
 * classification. Failing here is the correct behaviour — sending the data
 * anyway would be the violation.
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
      `No deployment of "${input.alias}" satisfies the "${input.classification}" classification`,
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
    super(`Model alias "${alias}" is not in the catalogue`, { alias });
  }
}

export class AliasNotAllowedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.FORBIDDEN;
  readonly status = 403;

  constructor(alias: string, projectId: string) {
    super(`The project policy forbids the alias "${alias}"`, { alias, project_id: projectId });
  }
}

export class CapabilityNotSupportedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(alias: string, capability: string) {
    super(`The alias "${alias}" does not support ${capability}`, { alias, capability });
  }
}

/** Every compatible deployment was tried and failed. */
export class AllDeploymentsFailedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.ALL_DEPLOYMENTS_FAILED;
  readonly status = 503;
  override readonly retryable = true;

  constructor(alias: string, attempts: number, lastError: string) {
    super(`All ${attempts.toString()} deployments of "${alias}" failed`, {
      alias,
      attempts,
      last_error: lastError,
      retry_after: 5,
    });
  }
}

/**
 * The stream dropped after the first token.
 *
 * No retry is possible: the client already received part of the answer, and
 * repeating would produce duplicate content. The partial usage is committed and
 * flagged.
 */
export class StreamInterruptedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.STREAM_INTERRUPTED;
  readonly status = 500;

  constructor(reason: string, tokensEmitted: number) {
    super('The stream was interrupted after the first token', {
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
    super('Content shows signs of prompt injection', { signals, score });
  }
}

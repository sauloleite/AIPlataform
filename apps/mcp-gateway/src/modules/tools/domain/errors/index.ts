import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

export class ToolNotFoundError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOOL_NOT_FOUND;
  readonly status = 404;

  constructor(toolId: string) {
    super('No such tool', { tool_id: toolId });
  }
}

/**
 * The tool exists, but this project may not use it.
 *
 * The allow-list is per project: a tool published in the registry is not
 * usable until somebody binds it here (reference doc 02 §3).
 */
export class ToolNotAllowedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOOL_NOT_ALLOWED;
  readonly status = 403;

  constructor(toolId: string, reason: string) {
    super(reason, { tool_id: toolId });
  }
}

/**
 * OWASP LLM05, improper output handling.
 *
 * The registry validates a tool's schema when it is PUBLISHED; nothing checked
 * the arguments at invoke time, so a model could send a string where a number
 * was declared, an unknown field, or a whole extra object, and the executor
 * would forward it. The six published design patterns against prompt injection
 * stop untrusted input from SELECTING an action; none of them governs what the
 * selected action CARRIES. This is that gap.
 *
 * 400, not 422: the argument is malformed against a schema the caller was
 * given, which is a bad request in the ordinary sense.
 */
export class ToolArgumentsInvalidError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOOL_ARGUMENTS_INVALID;
  readonly status = 400;

  constructor(toolId: string, reasons: readonly string[]) {
    super(`The arguments do not match the schema of ${toolId}`, {
      tool_id: toolId,
      // Returned to the caller because the caller is usually a model that can
      // correct itself on the next turn. They describe the SCHEMA, never the
      // value, so an argument carrying a secret is not echoed back.
      reasons: [...reasons],
    });
  }
}

export class ToolRateLimitedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOOL_RATE_LIMITED;
  readonly status = 429;
  override readonly retryable = true;

  constructor(toolId: string, retryAfterSeconds: number) {
    super('This tool has been called too often in this project', {
      tool_id: toolId,
      retry_after: retryAfterSeconds,
    });
  }
}

/**
 * OWASP LLM06, excessive agency: a high-risk tool does not run on the model's
 * say-so. Not an error in the usual sense -- it is the control working, and
 * the caller resumes with the approval id.
 */
export class ApprovalRequiredError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.APPROVAL_REQUIRED;
  readonly status = 202;

  constructor(toolId: string, approvalId: string, riskLevel: string) {
    super('A human has to approve this call before it runs', {
      tool_id: toolId,
      approval_id: approvalId,
      risk_level: riskLevel,
    });
  }
}

export class ToolExecutionFailedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOOL_EXECUTION_FAILED;
  readonly status = 502;

  constructor(toolId: string, reason: string) {
    super(reason, { tool_id: toolId });
  }
}

export class InvalidBindingError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(reason: string) {
    super(reason);
  }
}

export class ConnectionNotFoundError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.NOT_FOUND;
  readonly status = 404;

  constructor(connectionId: string) {
    super('No such connection', { connection_id: connectionId });
  }
}

export class ConnectionSlugTakenError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.CONFLICT;
  readonly status = 409;

  constructor(slug: string) {
    super('A connection with that slug already exists in this project', { slug });
  }
}

/**
 * Deleting a connection a published tool still points at would break that tool
 * at its next call, with an error naming something that no longer exists to
 * look up. Refusing here says which tool, while somebody is looking.
 */
export class ConnectionInUseError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.CONFLICT;
  readonly status = 409;

  constructor(connectionId: string, toolName: string) {
    super(`The tool "${toolName}" still uses this connection`, {
      connection_id: connectionId,
      tool_name: toolName,
    });
  }
}

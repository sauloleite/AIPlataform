import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

/**
 * Domain errors for this service.
 *
 * Each carries a STABLE code from the catalogue: it is what the client keys its
 * behaviour off, so changing the value is a breaking change.
 */
export class ExampleError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(detail: string) {
    super(detail);
  }
}

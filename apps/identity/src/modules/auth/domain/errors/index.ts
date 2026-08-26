import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

export class InvalidCredentialsError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.UNAUTHENTICATED;
  readonly status = 401;

  constructor() {
    // Deliberately generic message: distinguishing "no such user" from "wrong
    // password" hands an attacker an account enumerator.
    super('Invalid credentials');
  }
}

export class PrincipalDisabledError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.FORBIDDEN;
  readonly status = 403;

  constructor(principalId: string) {
    super('Principal disabled', { principal_id: principalId });
  }
}

export class PatExpiredError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOKEN_EXPIRED;
  readonly status = 401;

  constructor() {
    super('Personal access token expired');
  }
}

export class PatRevokedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.INVALID_TOKEN;
  readonly status = 401;

  constructor() {
    super('Personal access token revoked');
  }
}

export class NoSigningKeyError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.INTERNAL_ERROR;
  readonly status = 503;

  constructor() {
    super('No active signing key');
  }
}

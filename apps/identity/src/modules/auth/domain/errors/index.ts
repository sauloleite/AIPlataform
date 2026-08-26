import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

export class InvalidCredentialsError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.UNAUTHENTICATED;
  readonly status = 401;

  constructor() {
    // Mensagem deliberadamente generica: distinguir "usuario nao existe" de
    // "senha errada" entrega ao atacante um enumerador de contas.
    super('Credenciais invalidas');
  }
}

export class PrincipalDisabledError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.FORBIDDEN;
  readonly status = 403;

  constructor(principalId: string) {
    super('Principal desativado', { principal_id: principalId });
  }
}

export class PatExpiredError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.TOKEN_EXPIRED;
  readonly status = 401;

  constructor() {
    super('Personal Access Token expirado');
  }
}

export class PatRevokedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.INVALID_TOKEN;
  readonly status = 401;

  constructor() {
    super('Personal Access Token revogado');
  }
}

export class NoSigningKeyError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.INTERNAL_ERROR;
  readonly status = 503;

  constructor() {
    super('Nenhuma chave de assinatura ativa');
  }
}

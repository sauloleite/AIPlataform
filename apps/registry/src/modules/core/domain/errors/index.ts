import { DomainError, ERROR_CODES, type ErrorCode } from '@aia/errors';

/**
 * Erros de dominio deste servico.
 *
 * Cada um carrega um codigo ESTAVEL do catalogo: e por ele que o cliente decide
 * comportamento, entao mudar o valor e breaking change.
 */
export class ExemploError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.VALIDATION_FAILED;
  readonly status = 400;

  constructor(detalhe: string) {
    super(detalhe);
  }
}

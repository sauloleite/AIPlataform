import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './catalog.js';
import { DomainError, InternalError, NotFoundError } from './domain-error.js';
import { fromUnknown, toProblemDetails } from './problem-details.js';

class BudgetExhausted extends DomainError {
  readonly code = ERROR_CODES.BUDGET_EXHAUSTED;
  readonly status = 429;
  constructor(projectId: string, retryAfter: number) {
    super(`Orcamento do projeto ${projectId} esgotado`, {
      project_id: projectId,
      retry_after: retryAfter,
    });
  }
}

describe('toProblemDetails', () => {
  it('inclui type, title, status, code e as extensoes do erro', () => {
    const problem = toProblemDetails(new BudgetExhausted('proj-1', 60), {
      instance: '/v1/chat/completions',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });

    expect(problem).toMatchObject({
      type: 'https://aia.dev/errors/budget_exhausted',
      title: 'Orcamento do projeto esgotado',
      status: 429,
      code: 'budget_exhausted',
      instance: '/v1/chat/completions',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      project_id: 'proj-1',
      retry_after: 60,
    });
  });

  it('omite instance e trace_id quando nao ha contexto', () => {
    const problem = toProblemDetails(new NotFoundError('Projeto', 'proj-9'));

    expect(problem.instance).toBeUndefined();
    expect(problem.trace_id).toBeUndefined();
    expect(problem.status).toBe(404);
  });
});

describe('fromUnknown', () => {
  it('nao vaza a mensagem de um erro desconhecido', () => {
    const problem = fromUnknown(new Error('conexao recusada em mongo://interno:27017'));

    expect(problem.status).toBe(500);
    expect(problem.code).toBe('internal_error');
    expect(problem.detail).toBe('Erro interno');
    expect(JSON.stringify(problem)).not.toContain('mongo://');
  });

  it('preserva o erro de dominio quando ha um', () => {
    expect(fromUnknown(new InternalError('falhou', { step: 'commit' }))).toMatchObject({
      code: 'internal_error',
      step: 'commit',
    });
  });

  it('trata valores lancados que nem sao Error', () => {
    expect(fromUnknown('string solta').status).toBe(500);
  });
});

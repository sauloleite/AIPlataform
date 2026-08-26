import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '@aia/errors';
import { ProblemDetailsFilter } from './problem-details.filter.js';

/** Resposta e requisicao falsas com a superficie que o filtro usa. */
function hostFor(url = '/v1/chat/completions'): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const type = vi.fn(() => ({ send }));
  const status = vi.fn(() => ({ type, send }));
  const setHeader = vi.fn();

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, type, send, setHeader }),
      getRequest: () => ({ url }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, type, send, setHeader };
}

function bodyOf(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return send.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('ProblemDetailsFilter', () => {
  it('traduz erro de dominio preservando status e codigo estavel', () => {
    const { host, status, type, send } = hostFor();
    new ProblemDetailsFilter().catch(new NotFoundError('Projeto', 'proj-1'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    expect(bodyOf(send)).toMatchObject({
      type: 'https://aia.dev/errors/not_found',
      status: 404,
      code: 'not_found',
      resource: 'Projeto',
      id: 'proj-1',
      instance: '/v1/chat/completions',
    });
  });

  it('carrega os detalhes do erro como extensoes do Problem Details', () => {
    const { host, send } = hostFor();
    new ProblemDetailsFilter().catch(
      new ForbiddenError('sem permissao', { rule: 'project_owner', project_id: 'proj-1' }),
      host,
    );

    expect(bodyOf(send)).toMatchObject({ code: 'forbidden', rule: 'project_owner' });
  });

  it('define Retry-After quando o erro informa quando tentar de novo', () => {
    const { host, setHeader, send } = hostFor();
    new ProblemDetailsFilter().catch(new ValidationError('espere', { retry_after: 42 }), host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(bodyOf(send)['retry_after']).toBe(42);
  });

  it('NAO vaza a mensagem interna de um erro desconhecido', () => {
    const { host, status, send } = hostFor();
    new ProblemDetailsFilter().catch(
      new Error('conexao recusada em mongodb://interno:27017'),
      host,
    );

    expect(status).toHaveBeenCalledWith(500);
    const body = bodyOf(send);
    expect(body['detail']).toBe('Erro interno');
    expect(JSON.stringify(body)).not.toContain('mongodb://');
  });

  it('mapeia excecao do framework sem perder o status', () => {
    const { host, status, send } = hostFor();
    new ProblemDetailsFilter().catch(
      new HttpException('corpo invalido', HttpStatus.BAD_REQUEST),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(bodyOf(send)['code']).toBe('validation_failed');
  });

  it('trata valor lancado que nem e Error', () => {
    const { host, status } = hostFor();
    expect(() => {
      new ProblemDetailsFilter().catch('string solta', host);
    }).not.toThrow();
    expect(status).toHaveBeenCalledWith(500);
  });
});

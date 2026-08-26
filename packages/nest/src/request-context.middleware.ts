import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context.js';

/**
 * Abre o contexto da requisicao e devolve o `X-Request-Id` ao cliente,
 * para que um relato de erro possa ser localizado no log.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const header = request.headers['x-request-id'];
    const requestId = typeof header === 'string' && header !== '' ? header : randomUUID();
    const traceparent = request.headers['traceparent'];

    response.setHeader('X-Request-Id', requestId);

    runWithRequestContext(
      {
        requestId,
        ...(typeof traceparent === 'string' && { traceparent }),
      },
      () => {
        next();
      },
    );
  }
}

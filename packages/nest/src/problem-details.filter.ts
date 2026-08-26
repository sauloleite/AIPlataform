import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PROBLEM_CONTENT_TYPE, fromUnknown, isDomainError, type ProblemDetails } from '@aia/errors';
import { currentTraceId } from '@aia/telemetry';

/**
 * Translates any exception into Problem Details (RFC 9457).
 *
 * A domain error already carries its status and stable code; a framework
 * exception is mapped; anything else becomes a 500 with no detail, and the stack
 * goes only to the structured log, correlated by trace_id.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const traceId = currentTraceId();

    const problem = this.toProblem(exception, request.url, traceId);

    if (problem.status >= 500) {
      this.logger.error(
        {
          message: 'request failed',
          code: problem.code,
          path: request.url,
          trace_id: traceId,
        },
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (problem.status === 429 || problem.status === 403) {
      this.logger.warn({ message: problem.title, code: problem.code, trace_id: traceId });
    }

    if (typeof problem.retry_after === 'number') {
      response.setHeader('Retry-After', String(problem.retry_after));
    }

    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  }

  private toProblem(exception: unknown, path: string, traceId?: string): ProblemDetails {
    const context = { instance: path, ...(traceId !== undefined && { traceId }) };

    if (isDomainError(exception)) return fromUnknown(exception, context);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const detail =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);

      return {
        type: `https://aia.dev/errors/${status >= 500 ? 'internal_error' : 'validation_failed'}`,
        title: exception.name,
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
        code: status >= 500 ? 'internal_error' : 'validation_failed',
        ...context,
      };
    }

    return fromUnknown(exception, context);
  }
}

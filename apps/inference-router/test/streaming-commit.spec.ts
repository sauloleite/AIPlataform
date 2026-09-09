import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

import { CompletionsController } from '../src/modules/completions/presentation/http/completions.controller.js';
import { BudgetExhaustedError } from '../src/modules/completions/domain/errors/index.js';
import type { CreateChatCompletion } from '../src/modules/completions/application/use-cases/create-chat-completion.js';
import type { StreamEvent } from '../src/modules/completions/application/dto.js';
import { ROLES } from '@aia/auth';
import type { AuthenticatedRequest } from '@aia/nest';

/**
 * Enough of an Express response to see what reached the wire, and when.
 *
 * `headersSent` and the throw from `setHeader` are not decoration: this fake
 * used to accept headers after the body had gone out, and that silence is what
 * let a commit timer fire onto an already-answered response and take the whole
 * router down with ERR_HTTP_HEADERS_SENT. A fake that forgives what the real
 * one refuses tests the fake.
 */
class RecordingResponse {
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  statusCode: number | undefined;
  headersFlushed = false;
  headersSent = false;
  ended = false;
  body: unknown;
  writableEnded = false;

  private readonly listeners = new Map<string, () => void>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): void {
    if (this.headersSent) {
      throw Object.assign(new Error('Cannot set headers after they are sent to the client'), {
        code: 'ERR_HTTP_HEADERS_SENT',
      });
    }
    this.headers[name] = value;
  }

  flushHeaders(): void {
    this.headersFlushed = true;
    this.headersSent = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
    this.writableEnded = true;
  }

  type(): this {
    return this;
  }

  send(body: unknown): this {
    this.body = body;
    this.headersSent = true;
    return this;
  }

  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }
}

function aRequest(): AuthenticatedRequest {
  return {
    principal: {
      id: 'user-ana',
      type: 'user',
      scopes: [],
      globalRoles: [],
      memberships: [{ projectId: 'proj-1', roles: [ROLES.PROJECT_EDITOR] }],
    },
    projectId: 'proj-1',
    headers: {},
  } as unknown as AuthenticatedRequest;
}

const BODY = {
  model: 'chat-local',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
};

/** A use case whose stream does whatever the test needs. */
function useCaseYielding(events: () => AsyncGenerator<StreamEvent>): CreateChatCompletion {
  return { stream: events } as unknown as CreateChatCompletion;
}

function controllerFor(useCase: CreateChatCompletion): CompletionsController {
  return new CompletionsController(useCase, {} as never, {} as never);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The wait for the FIRST token is the one nobody sees.
 *
 * Nothing is on the wire until the writer exists, and a proxy drops a silent
 * connection at sixty seconds -- ALB, GCLB and nginx all default to it. A local
 * model loads from disk on the first call and is allowed a hundred and twenty
 * seconds for it, so this is the zero-cost path, not an exotic case.
 */
describe('committing to a 200 while the first token is still coming', () => {
  it('sends headers and a heartbeat when the first token is slow', async () => {
    const response = new RecordingResponse();
    const controller = controllerFor(
      useCaseYielding(async function* () {
        // Longer than the commit deadline and than a proxy's idle timeout.
        await vi.advanceTimersByTimeAsync(70_000);
        yield { kind: 'delta', content: 'at last' };
      }),
    );

    await controller.chat(aRequest(), response as unknown as Response, BODY);

    expect(response.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    // The heartbeat is a comment frame, which is what keeps the proxy from
    // deciding the connection is idle.
    expect(response.chunks.some((chunk) => chunk.startsWith(': ping'))).toBe(true);
  });

  it('does not disable proxy buffering only after the first token', async () => {
    const response = new RecordingResponse();
    const controller = controllerFor(
      useCaseYielding(async function* () {
        await vi.advanceTimersByTimeAsync(70_000);
        yield { kind: 'delta', content: 'at last' };
      }),
    );

    await controller.chat(aRequest(), response as unknown as Response, BODY);

    // Without this a reverse proxy holds the whole stream and delivers it as
    // one block, which looks exactly like the model being slow.
    expect(response.headers['X-Accel-Buffering']).toBe('no');
  });

  it('still answers with Problem Details when it fails before the deadline', async () => {
    const response = new RecordingResponse();
    const controller = controllerFor(
      useCaseYielding(async function* () {
        // Time passes, but less than the deadline. Advancing the clock is what
        // makes this test say something: without it, any deadline at all --
        // including zero -- would pass, because an unadvanced timer never runs.
        await vi.advanceTimersByTimeAsync(5_000);
        throw new BudgetExhaustedError('proj-1', 60);

        yield { kind: 'delta', content: '' };
      }),
    );

    await controller.chat(aRequest(), response as unknown as Response, BODY);

    // The whole point of committing late: a budget refusal takes milliseconds
    // and must still be a 429 the caller can branch on, not an event inside a
    // 200 that most clients will treat as success.
    expect(response.statusCode).toBe(429);
    expect(response.body).toMatchObject({ code: 'budget_exhausted' });
    expect(response.chunks).toHaveLength(0);
  });

  it('reports a failure that arrives after the deadline inside the stream', async () => {
    const response = new RecordingResponse();
    const controller = controllerFor(
      useCaseYielding(async function* () {
        await vi.advanceTimersByTimeAsync(70_000);
        throw new BudgetExhaustedError('proj-1', 60);

        yield { kind: 'delta', content: '' };
      }),
    );

    await controller.chat(aRequest(), response as unknown as Response, BODY);

    // Headers are already gone, so the status is spent. The error has to travel
    // as an event, and it does rather than being swallowed.
    expect(response.statusCode).toBe(200);
    expect(response.chunks.join('')).toContain('budget_exhausted');
  });

  it('leaves no timer armed when the stream fails before the first event', async () => {
    const response = new RecordingResponse();
    const controller = controllerFor(
      useCaseYielding(async function* () {
        throw new BudgetExhaustedError('proj-1', 60);

        yield { kind: 'delta', content: '' };
      }),
    );

    await controller.chat(aRequest(), response as unknown as Response, BODY);
    expect(response.statusCode).toBe(429);

    // The failure never enters the loop, so nothing there clears the deadline.
    // Left armed, it fires fifteen seconds later onto a response that has
    // already been answered -- an exception thrown inside a timer callback,
    // with no caller to catch it, which ends the process.
    expect(vi.getTimerCount()).toBe(0);

    // And even if something else arms it, the commit must be a no-op rather
    // than a crash.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(response.chunks).toHaveLength(0);
  });

  it('leaves no timer running once the stream is done', async () => {
    const response = new RecordingResponse();
    const controller = controllerFor(
      useCaseYielding(async function* () {
        yield { kind: 'delta', content: 'fast' };
      }),
    );

    await controller.chat(aRequest(), response as unknown as Response, BODY);

    // A commit timer that outlives the request would flush headers onto a
    // response that has already ended.
    expect(vi.getTimerCount()).toBe(0);
  });
});

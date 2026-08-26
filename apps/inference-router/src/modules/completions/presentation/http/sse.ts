import type { Response } from 'express';

/**
 * Server-Sent Events writer (reference doc 03 §6).
 *
 * Named events, an incrementing `id` for reconnection, and a heartbeat every
 * 15 s so proxies do not drop an idle connection while generation is under way.
 */
export class SseWriter {
  private eventId = 0;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly response: Response,
    heartbeatMs = 15_000,
  ) {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // Disables reverse-proxy buffering: without it the stream arrives in one lump.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    this.heartbeat = setInterval(() => {
      if (!this.closed) this.response.write(': ping\n\n');
    }, heartbeatMs);
    // The heartbeat must not keep the process alive during shutdown.
    this.heartbeat.unref();

    response.on('close', () => {
      this.stopHeartbeat();
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed || this.response.writableEnded;
  }

  send(event: string, data: unknown): void {
    if (this.isClosed) return;
    this.eventId += 1;
    this.response.write(`id: ${this.eventId.toString()}\n`);
    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    this.stopHeartbeat();
    if (!this.isClosed) this.response.end();
    this.closed = true;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}

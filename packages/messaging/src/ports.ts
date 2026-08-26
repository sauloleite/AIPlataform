import type { CloudEvent } from './cloud-events.js';

/** Publica fatos consumados. Quem publica nao sabe quem consome. */
export interface EventPublisher {
  publish(event: CloudEvent): Promise<void>;
  publishAll(events: CloudEvent[]): Promise<void>;
}

/** Handler de um evento. Deve ser idempotente: pode ser chamado mais de uma vez. */
export type EventHandler = (event: CloudEvent) => Promise<void>;

export interface EventSubscriber {
  subscribe(eventType: string, handler: EventHandler): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Trabalho pesado que sai do caminho da request (doc 02, principio 6). */
export interface JobQueue<TPayload = unknown> {
  enqueue(
    payload: TPayload,
    options?: { idempotencyKey?: string; delayMs?: number },
  ): Promise<string>;
  size(): Promise<number>;
}

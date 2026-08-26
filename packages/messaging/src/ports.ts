import type { CloudEvent } from './cloud-events.js';

/** Publishes accomplished facts. The publisher does not know who consumes. */
export interface EventPublisher {
  publish(event: CloudEvent): Promise<void>;
  publishAll(events: CloudEvent[]): Promise<void>;
}

/** Handler for one event. Must be idempotent: it may be called more than once. */
export type EventHandler = (event: CloudEvent) => Promise<void>;

export interface EventSubscriber {
  subscribe(eventType: string, handler: EventHandler): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Heavy work moved off the request path (reference doc 02, principle 6). */
export interface JobQueue<TPayload = unknown> {
  enqueue(
    payload: TPayload,
    options?: { idempotencyKey?: string; delayMs?: number },
  ): Promise<string>;
  size(): Promise<number>;
}

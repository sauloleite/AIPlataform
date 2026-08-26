import type { CloudEvent } from './cloud-events.js';
import type { EventHandler, EventPublisher, EventSubscriber } from './ports.js';

/**
 * In-memory publisher for application tests.
 *
 * A fake, not a mock: it honours the contract for real and lets the test inspect
 * what was published, without coupling the test to specific calls
 * (reference doc 03 §7).
 */
export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  readonly published: CloudEvent[] = [];
  private readonly handlers = new Map<string, EventHandler[]>();
  private failNext = 0;

  async publish(event: CloudEvent): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated publish failure');
    }
    this.published.push(event);
    for (const handler of this.handlers.get(event.type) ?? []) {
      await handler(event);
    }
  }

  async publishAll(events: CloudEvent[]): Promise<void> {
    for (const event of events) await this.publish(event);
  }

  async subscribe(eventType: string, handler: EventHandler): Promise<void> {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
    return Promise.resolve();
  }

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }

  /** Makes the next `count` publishes fail, to exercise the relay. */
  failNextPublishes(count: number): void {
    this.failNext = count;
  }

  ofType(eventType: string): CloudEvent[] {
    return this.published.filter((event) => event.type === eventType);
  }

  clear(): void {
    this.published.length = 0;
    this.failNext = 0;
  }
}

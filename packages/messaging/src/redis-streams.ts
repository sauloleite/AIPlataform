import type { Redis } from 'ioredis';
import type { CloudEvent } from './cloud-events.js';
import type { EventHandler, EventPublisher, EventSubscriber } from './ports.js';

/**
 * Barramento de eventos sobre Redis Streams (ADR-008 na versao OSS).
 *
 * Redis Streams da o que a plataforma precisa de um broker: entrega ao menos uma
 * vez, grupos de consumidores, ack explicito e mensagens pendentes visiveis para
 * dead-letter. Evita subir um broker separado quando o Redis ja e obrigatorio
 * para o orcamento atomico.
 */
export interface RedisStreamOptions {
  /** Prefixo dos streams. Um stream por tipo de evento. */
  keyPrefix?: string;
  /** Limite aproximado de entradas por stream, para nao crescer sem fim. */
  maxLength?: number;
}

function streamKey(prefix: string, eventType: string): string {
  return `${prefix}:${eventType}`;
}

export class RedisStreamPublisher implements EventPublisher {
  private readonly prefix: string;
  private readonly maxLength: number;

  constructor(
    private readonly redis: Redis,
    options: RedisStreamOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? 'aia:events';
    this.maxLength = options.maxLength ?? 100_000;
  }

  async publish(event: CloudEvent): Promise<void> {
    await this.redis.xadd(
      streamKey(this.prefix, event.type),
      'MAXLEN',
      '~',
      this.maxLength,
      '*',
      'event',
      JSON.stringify(event),
    );
  }

  async publishAll(events: CloudEvent[]): Promise<void> {
    if (events.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const event of events) {
      pipeline.xadd(
        streamKey(this.prefix, event.type),
        'MAXLEN',
        '~',
        this.maxLength,
        '*',
        'event',
        JSON.stringify(event),
      );
    }
    await pipeline.exec();
  }
}

export interface RedisStreamSubscriberOptions extends RedisStreamOptions {
  /** Grupo de consumidores. Todas as replicas de um servico usam o mesmo. */
  group: string;
  /** Identifica esta replica dentro do grupo. */
  consumer: string;
  blockMs?: number;
  batchSize?: number;
  /** Entregas antes de mandar para o dead-letter. */
  maxDeliveries?: number;
  onError?: (error: unknown, event: CloudEvent) => void;
  onDeadLetter?: (event: CloudEvent, deliveries: number) => void;
}

type StreamEntry = [id: string, fields: string[]];
type StreamReply = [stream: string, entries: StreamEntry[]];

export class RedisStreamSubscriber implements EventSubscriber {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly prefix: string;
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisStreamSubscriberOptions,
  ) {
    this.prefix = options.keyPrefix ?? 'aia:events';
  }

  async subscribe(eventType: string, handler: EventHandler): Promise<void> {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);

    const key = streamKey(this.prefix, eventType);
    try {
      await this.redis.xgroup('CREATE', key, this.options.group, '$', 'MKSTREAM');
    } catch (error) {
      // BUSYGROUP: o grupo ja existe, que e o caso normal apos o primeiro boot.
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
    }
  }

  async start(): Promise<void> {
    this.running = true;
    for (;;) {
      // `running` e desligado por `stop()`, de fora deste fluxo. A analise de
      // tipos nao enxerga isso e acharia a condicao sempre verdadeira.
      if (!this.isRunning()) return;
      await this.readOnce();
    }
  }

  private isRunning(): boolean {
    return this.running;
  }

  async stop(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }

  /** Um ciclo de leitura. Exposto para teste sem laco infinito. */
  async readOnce(): Promise<number> {
    const types = [...this.handlers.keys()];
    if (types.length === 0) return 0;

    const keys = types.map((type) => streamKey(this.prefix, type));
    const reply = (await this.redis.xreadgroup(
      'GROUP',
      this.options.group,
      this.options.consumer,
      'COUNT',
      this.options.batchSize ?? 10,
      'BLOCK',
      this.options.blockMs ?? 5_000,
      'STREAMS',
      ...keys,
      ...keys.map(() => '>'),
    )) as StreamReply[] | null;

    if (reply === null) return 0;

    let handled = 0;
    for (const [stream, entries] of reply) {
      for (const [id, fields] of entries) {
        handled += await this.dispatch(stream, id, fields);
      }
    }
    return handled;
  }

  private async dispatch(stream: string, id: string, fields: string[]): Promise<number> {
    const payloadIndex = fields.indexOf('event');
    const raw = payloadIndex >= 0 ? fields[payloadIndex + 1] : undefined;
    if (raw === undefined) {
      await this.redis.xack(stream, this.options.group, id);
      return 0;
    }

    const event = JSON.parse(raw) as CloudEvent;
    const handlers = this.handlers.get(event.type) ?? [];

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        this.options.onError?.(error, event);
        const deliveries = await this.deliveryCount(stream, id);
        if (deliveries < (this.options.maxDeliveries ?? 5)) {
          // Sem ack: a mensagem fica pendente e volta na proxima leitura.
          return 0;
        }
        this.options.onDeadLetter?.(event, deliveries);
      }
    }

    await this.redis.xack(stream, this.options.group, id);
    return 1;
  }

  private async deliveryCount(stream: string, id: string): Promise<number> {
    const pending = (await this.redis.xpending(stream, this.options.group, id, id, 1)) as [
      string,
      string,
      number,
      number,
    ][];
    return pending[0]?.[3] ?? 1;
  }
}

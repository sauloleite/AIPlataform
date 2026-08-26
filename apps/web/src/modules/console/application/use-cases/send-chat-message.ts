import { Money } from '../../domain/money';
import type { ChatStreamEvent, ChatTurn, PlatformGateway, RoutingReport } from '../ports';

export interface SendChatMessageInput {
  projectId: string;
  alias: string;
  history: ChatTurn[];
  message: string;
  maxTokens?: number;
}

/** What the console shows once a turn finishes: how the platform served it. */
export interface ServedBy {
  provider?: string;
  providerModel?: string;
  deploymentId?: string;
  dataZone?: string;
  cost?: string;
  cacheHit: boolean;
  /** The policy came from cache because governance was unreachable. */
  policyStale: boolean;
  /** The budget was not verified because Redis was unreachable. */
  budgetUnverified: boolean;
  attempts: number;
}

export type ChatUpdate =
  | { kind: 'delta'; content: string }
  | { kind: 'finished'; content: string; servedBy: ServedBy }
  | { kind: 'error'; code: string; message: string };

/**
 * Sends a turn and streams the answer back.
 *
 * The routing block the platform attaches to the answer is surfaced rather than
 * dropped. It is what makes the guarantees observable: a `restricted` project
 * shows `local` there, and if a call ever came back served from `us`, the
 * screen would say so. `policy_stale` and `budget_unverified` are surfaced for
 * the same reason — the platform degrades on purpose, and a degraded answer
 * that looks identical to a healthy one teaches the operator nothing.
 */
export class SendChatMessage {
  constructor(private readonly platform: PlatformGateway) {}

  async *execute(accessToken: string, input: SendChatMessageInput): AsyncGenerator<ChatUpdate> {
    const messages: ChatTurn[] = [...input.history, { role: 'user', content: input.message }];

    let assembled = '';

    for await (const event of this.platform.streamChat(accessToken, {
      projectId: input.projectId,
      alias: input.alias,
      messages,
      ...(input.maxTokens !== undefined && { maxTokens: input.maxTokens }),
    })) {
      const update = this.toUpdate(event, assembled);
      if (event.kind === 'delta') assembled += event.content;
      if (event.kind === 'finished' && event.content !== '') assembled = event.content;
      yield update;
    }
  }

  private toUpdate(event: ChatStreamEvent, assembled: string): ChatUpdate {
    if (event.kind === 'delta') return { kind: 'delta', content: event.content };
    if (event.kind === 'error') return { kind: 'error', code: event.code, message: event.message };

    return {
      kind: 'finished',
      // A cache hit arrives as a single `finished` with the whole answer and no
      // deltas at all; a normal stream arrives as deltas with an empty final
      // content. Preferring whichever is non-empty covers both without the
      // caller having to know which happened.
      content: event.content !== '' ? event.content : assembled,
      servedBy: toServedBy(event.routing),
    };
  }
}

export function toServedBy(routing: RoutingReport): ServedBy {
  return {
    ...(routing.provider !== undefined && { provider: routing.provider }),
    ...(routing.providerModel !== undefined && { providerModel: routing.providerModel }),
    ...(routing.deploymentId !== undefined && { deploymentId: routing.deploymentId }),
    ...(routing.dataZone !== undefined && { dataZone: routing.dataZone }),
    ...(routing.cost !== undefined && { cost: Money.fromJson(routing.cost).format() }),
    cacheHit: routing.cacheHit ?? false,
    policyStale: routing.policyStale ?? false,
    budgetUnverified: routing.budgetUnverified ?? false,
    attempts: routing.attempts ?? 1,
  };
}

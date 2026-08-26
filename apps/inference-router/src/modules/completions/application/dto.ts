import type { ChatMessageInput } from './ports.js';
import type { Cost, DataZone, ProviderName } from '../domain/value-objects/index.js';

/** Comando de caso de uso. Sem `Request`, sem header, sem decorator. */
export interface CreateChatCompletionCommand {
  requestId: string;
  projectId: string;
  principalId: string;
  alias: string;
  messages: ChatMessageInput[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export interface CreateEmbeddingsCommand {
  requestId: string;
  projectId: string;
  principalId: string;
  alias: string;
  input: string[];
}

/** Como a plataforma atendeu. Evidencia de residencia de dados e diagnostico. */
export interface RoutingInfo {
  deploymentId: string;
  provider: ProviderName;
  providerModel: string;
  dataZone: DataZone;
  cost: Cost;
  cacheHit: boolean;
  policyStale: boolean;
  budgetUnverified: boolean;
  attempts: number;
}

export interface ChatCompletionResult {
  id: string;
  model: string;
  content: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  routing: RoutingInfo;
}

export type StreamEvent =
  | { kind: 'delta'; content: string }
  | { kind: 'finished'; result: ChatCompletionResult }
  | { kind: 'error'; code: string; message: string };

export interface EmbeddingsResult {
  model: string;
  vectors: number[][];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  routing: RoutingInfo;
}

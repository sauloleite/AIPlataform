import type {
  ChatMessageInput,
  ToolCallOutput,
  ToolChoiceInput,
  ToolDefinitionInput,
} from './ports.js';
import type { Cost, DataZone, ProviderName } from '../domain/value-objects/index.js';

/** A use case command. No `Request`, no header, no decorator. */
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
  tools?: ToolDefinitionInput[];
  toolChoice?: ToolChoiceInput;
}

export interface CreateEmbeddingsCommand {
  requestId: string;
  projectId: string;
  principalId: string;
  alias: string;
  input: string[];
}

/** How the platform served the call. Data residency evidence and diagnostics. */
export interface RoutingInfo {
  deploymentId: string;
  provider: ProviderName;
  providerModel: string;
  dataZone: DataZone;
  cost: Cost;
  cacheHit: boolean;
  policyStale: boolean;
  budgetUnverified: boolean;
  /**
   * The content reached the provider without being inspected.
   *
   * Beside `budgetUnverified` because it is the same kind of fact: the platform
   * answered while one of its controls was not working, and the caller is
   * entitled to know which. A restricted project never sees this true -- it is
   * refused instead (ADR-026).
   */
  guardrailsUnverified: boolean;
  attempts: number;
}

export interface ChatCompletionResult {
  id: string;
  model: string;
  content: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  routing: RoutingInfo;
  /** What the model asked to run. The platform executes none of it. */
  toolCalls?: ToolCallOutput[];
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

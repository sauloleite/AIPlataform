import type {
  ApprovalRequest,
  ChatCompletion,
  ChatCompletionRequest,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ModelAliasDto,
  RoutingMetadata,
  RunDetailDto,
  SearchRequest,
  SearchResponse,
  StartRunRequest,
  Usage,
} from '@aia/contracts';

/**
 * What the platform offers a client, as one interface.
 *
 * Two things implement it: `AiaClient`, which speaks HTTP, and `FakeAia`, which
 * answers from memory. That is not a convenience -- it is the design test. If a
 * capability cannot be expressed here without leaking a URL, a header or a
 * status code, the API is asking the caller to know too much.
 *
 * Every method takes what the CALLER decides and nothing else: no project id,
 * no token, no base URL. Those belong to the client, because a caller passing
 * its own tenant on every call is a caller that can pass the wrong one.
 */
export interface Aia {
  /** A completion, waited for. */
  chat(request: ChatRequest): Promise<ChatResult>;

  /**
   * A completion, as it arrives.
   *
   * Retry stops at the first token, deliberately: a stream that has already
   * delivered text cannot be replayed without repeating it (POLICIES.INFERENCE_STREAMING).
   */
  chatStream(request: ChatRequest): AsyncGenerator<ChatEvent>;

  embed(request: EmbedRequest): Promise<EmbedResult>;

  /** The aliases this project may use, already filtered by its classification. */
  models(): Promise<ModelAlias[]>;

  search(storeId: string, request: SearchQuery): Promise<SearchResult>;

  /** Starts an agent run and waits for it to settle -- which may be an approval. */
  startRun(agentId: string, request: RunInput): Promise<Run>;

  getRun(runId: string): Promise<Run>;

  /** Answers the run's pending tool call, and returns where that left it. */
  approve(runId: string, decision: Approval): Promise<Run>;
}

/**
 * The request types are the contract's, with the OPTIONAL fields put back.
 *
 * The generator reads a property carrying a `default` as always present, which
 * is right for a response -- the server did fill it in -- and wrong for a
 * request, where the default exists precisely so the caller can leave it out.
 * Taking the generated type as-is would make every caller write `top_k: 5` and
 * `mode: 'hybrid'` to say "whatever you normally do".
 *
 * `stream` is dropped rather than made optional: the method you call decides
 * it, and a second way to say the same thing is one that can disagree.
 */
export type ChatRequest = Omit<ChatCompletionRequest, 'stream'>;
export type ChatResult = ChatCompletion;
export type EmbedRequest = EmbeddingsRequest;
export type EmbedResult = EmbeddingsResponse;
export type ModelAlias = ModelAliasDto;
export type SearchQuery = Optional<SearchRequest, 'top_k' | 'mode'>;
export type SearchResult = SearchResponse;
export type RunInput = StartRunRequest;
export type Approval = Optional<ApprovalRequest, 'approved'>;
export type Run = RunDetailDto;
export type { RoutingMetadata, Usage };

type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** What a stream carries, as a union: a consumer that forgets a case fails to compile. */
export type ChatEvent =
  | { kind: 'delta'; content: string }
  | { kind: 'finished'; result: ChatResult }
  | { kind: 'error'; code: string; message: string };

/**
 * A token, or a way to get one.
 *
 * The function form exists because a personal access token in a constant is a
 * credential with no expiry: a service using client credentials refreshes, and
 * the SDK has to ask again rather than cache what it was handed once.
 */
export type TokenSource = string | (() => string | Promise<string>);

export interface AiaOptions {
  /** Where the platform answers, e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** The tenant. Required on every call the platform serves, so it lives here. */
  projectId: string;
  token: TokenSource;
  /** Injected so a test can answer without a socket. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

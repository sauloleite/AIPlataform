import { ERROR_CODES } from '@aia/errors';

import { PlatformError } from './errors.js';
import type {
  Aia,
  Approval,
  ChatEvent,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  ModelAlias,
  Run,
  RunInput,
  SearchQuery,
  SearchResult,
} from './types.js';

export interface FakeOptions {
  /** What every completion answers. */
  reply?: string;
  /** Aliases `models()` reports. Defaults to one local, zero-cost alias. */
  models?: ModelAlias[];
  /** Chunks the fake store returns for any query. */
  documents?: { documentId: string; title: string; text: string }[];
  /** Vector width. Three, because a test asserting on 1536 numbers asserts nothing. */
  dimensions?: number;
}

/**
 * The platform, in memory.
 *
 * This exists to answer one question about the design: can somebody test code
 * that uses this platform without a credential, a container or a network? If
 * the answer needs a running service, then the SDK has leaked the transport
 * into its interface and the interface is wrong.
 *
 * It is not a mock. Nothing here records calls or asserts an order; it answers
 * the way the platform answers, including the refusals, because those are the
 * paths a caller most needs to be able to reproduce. `failWith` is how a test
 * asks for one.
 */
export class FakeAia implements Aia {
  private readonly reply: string;
  private readonly modelList: ModelAlias[];
  private readonly documents: { documentId: string; title: string; text: string }[];
  private readonly dimensions: number;
  private readonly runs = new Map<string, Run>();
  private nextFailure: PlatformError | undefined;
  private counter = 0;

  constructor(options: FakeOptions = {}) {
    this.reply = options.reply ?? 'ok';
    this.dimensions = options.dimensions ?? 3;
    this.documents = options.documents ?? [];
    this.modelList = options.models ?? [
      {
        id: 'chat-local',
        description: 'Local model only. No data leaves the machine.',
        capabilities: ['chat'],
        data_zones: ['local'],
      } as ModelAlias,
    ];
  }

  /**
   * Makes the NEXT call fail, once.
   *
   * A caller's retry, fallback and error message are the parts most likely to
   * be wrong and least likely to be exercised, because reproducing an exhausted
   * budget against a real platform means exhausting a real budget.
   */
  failWith(
    code: keyof typeof ERROR_CODES,
    status = 400,
    detail = 'The fake was asked to fail',
  ): void {
    this.nextFailure = new PlatformError({
      type: `https://aia.dev/errors/${ERROR_CODES[code]}`,
      title: 'Refused by the fake',
      status,
      detail,
      code: ERROR_CODES[code],
      instance: '/fake',
      ...(status === 429 && { retry_after: 30 }),
    });
  }

  private check(): void {
    const failure = this.nextFailure;
    if (failure === undefined) return;
    this.nextFailure = undefined;
    throw failure;
  }

  private id(prefix: string): string {
    this.counter += 1;
    // Deterministic, because a test that asserts on an id generated from the
    // clock is a test that cannot assert on an id.
    return `${prefix}-${this.counter.toString().padStart(4, '0')}`;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.check();
    return this.completionFor(request);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatEvent> {
    this.check();
    // Word by word, because a consumer that concatenates deltas correctly and
    // one that keeps only the last look identical against a single chunk.
    for (const word of this.reply.split(' ')) {
      yield { kind: 'delta', content: word };
    }
    yield { kind: 'finished', result: this.completionFor(request) };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    this.check();
    const input = Array.isArray(request.input) ? request.input : [request.input];
    return {
      object: 'list',
      model: request.model,
      data: input.map((_, index) => ({
        object: 'embedding',
        index,
        embedding: Array.from({ length: this.dimensions }, (_unused, axis) => (axis + 1) / 10),
      })),
      usage: { prompt_tokens: input.length, completion_tokens: 0, total_tokens: input.length },
    };
  }

  async models(): Promise<ModelAlias[]> {
    this.check();
    return this.modelList;
  }

  async search(storeId: string, request: SearchQuery): Promise<SearchResult> {
    this.check();
    const needle = request.query.toLowerCase();
    const hits = this.documents
      .filter((document) => document.text.toLowerCase().includes(needle))
      .slice(0, request.top_k)
      .map((document, index) => ({
        document_id: document.documentId,
        document_title: document.title,
        chunk_index: index,
        score: 1 - index / 10,
        retrieval: 'both' as const,
        text: document.text,
      }));
    return { results: hits, store_id: storeId } as unknown as SearchResult;
  }

  async startRun(agentId: string, request: RunInput): Promise<Run> {
    this.check();
    const run = {
      id: this.id('run'),
      agent_id: agentId,
      agent_version: 1,
      project_id: 'fake-project',
      status: 'completed',
      step: 1,
      output: this.reply,
      pending_call: null,
      messages: [
        { role: 'user', content: request.input },
        { role: 'assistant', content: this.reply },
      ],
    } as unknown as Run;
    this.runs.set(run.id, run);
    return run;
  }

  async getRun(runId: string): Promise<Run> {
    this.check();
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new PlatformError({
        type: 'https://aia.dev/errors/not_found',
        title: 'Not found',
        status: 404,
        detail: 'run not found',
        code: ERROR_CODES.NOT_FOUND,
        instance: `/v1/runs/${runId}`,
      });
    }
    return run;
  }

  async approve(runId: string, decision: Approval): Promise<Run> {
    this.check();
    const run = this.runs.get(runId);
    if (run?.status !== 'waiting_approval') {
      // The platform answers 409 here, and a caller that approves twice has to
      // be able to see the difference between "done" and "was never waiting".
      throw new PlatformError({
        type: 'https://aia.dev/errors/conflict',
        title: 'State conflict',
        status: 409,
        detail: 'The run is not waiting on that call',
        code: ERROR_CODES.CONFLICT,
        instance: `/v1/runs/${runId}/approve`,
      });
    }
    // A refusal is not a failure: the contract says it "lets the run continue
    // without it", so the run finishes either way and only the answer differs.
    const refused = !decision.approved;
    const resumed = {
      ...run,
      status: 'completed',
      pending_call: null,
      output: refused ? 'The tool call was refused.' : this.reply,
    } as Run;
    this.runs.set(runId, resumed);
    return resumed;
  }

  /** Puts a run into `waiting_approval`, so the approval path can be tested. */
  holdForApproval(agentId: string, toolName: string): Run {
    const run = {
      id: this.id('run'),
      agent_id: agentId,
      agent_version: 1,
      project_id: 'fake-project',
      status: 'waiting_approval',
      step: 1,
      output: null,
      pending_call: {
        id: this.id('call'),
        tool_name: toolName,
        arguments: {},
        risk_level: 'high',
      },
    } as unknown as Run;
    this.runs.set(run.id, run);
    return run;
  }

  private completionFor(request: ChatRequest): ChatResult {
    return {
      id: this.id('chatcmpl'),
      object: 'chat.completion',
      created: 0,
      model: request.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: this.reply }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      aia: {
        deployment_id: 'fake',
        provider: 'fake',
        data_zone: 'local',
        cost: { currency: 'BRL', micros: 0 },
      },
    } as unknown as ChatResult;
  }
}

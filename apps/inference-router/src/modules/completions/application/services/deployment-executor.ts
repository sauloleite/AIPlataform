import { Inject, Injectable, Logger } from '@nestjs/common';
import { SpanKind, type Span } from '@opentelemetry/api';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';
import { AIA_ATTR, GEN_AI_ATTR, GEN_AI_SPAN, getTracer, recordSpanError } from '@aia/telemetry';
import { AllDeploymentsFailedError } from '../../domain/errors/index.js';
import { sameWidth } from '../../domain/services/model-selection-policy.js';
import type { Deployment } from '../../domain/entities/deployment.js';
import {
  MODEL_PROVIDERS,
  type ChatChunk,
  type ChatRequestInput,
  type ChatResult,
  type EmbeddingsResult,
  type ModelProvider,
} from '../ports.js';

export interface ChatAttempt {
  deployment: Deployment;
  result: ChatResult;
  attempts: number;
}

export interface OpenedStream {
  deployment: Deployment;
  chunks: AsyncIterable<ChatChunk>;
  attempts: number;
}

/**
 * Priority-based balancing, failover and a circuit breaker per deployment.
 *
 * This is what a managed AI gateway would provide out of the box. With no cloud
 * it is ours — and it lives here, over the `ModelProvider` port, so it stays
 * testable without a network (ADR-012).
 *
 * Streaming has a rule of its own: switching deployment is only valid BEFORE the
 * first token. After that the client already received content, and starting over
 * would duplicate the answer (reference doc 02 §8).
 */
@Injectable()
export class DeploymentExecutor {
  private readonly logger = new Logger(DeploymentExecutor.name);
  private readonly byProvider = new Map<string, ModelProvider>();
  private readonly chatExecutor: ResilienceExecutor;
  private readonly streamExecutor: ResilienceExecutor;
  private readonly localChatExecutor: ResilienceExecutor;
  private readonly localStreamExecutor: ResilienceExecutor;
  private readonly embeddingsExecutor: ResilienceExecutor;

  /**
   * The executor's own tracer.
   *
   * Instrumentation of model calls lives HERE rather than in each adapter: that
   * way all four providers emit exactly the same attributes, and a new provider
   * inherits correct telemetry without anyone having to remember.
   */
  private readonly tracer = getTracer('aia.inference-router');

  constructor(@Inject(MODEL_PROVIDERS) providers: ModelProvider[]) {
    for (const provider of providers) this.byProvider.set(provider.provider, provider);

    const onCircuitStateChange = ({
      key,
      from,
      to,
    }: {
      key: string;
      from: string;
      to: string;
    }): void => {
      this.logger.warn(`circuit for ${key}: ${from} -> ${to}`);
    };

    this.chatExecutor = new ResilienceExecutor(POLICIES.INFERENCE, {}, { onCircuitStateChange });
    this.streamExecutor = new ResilienceExecutor(
      POLICIES.INFERENCE_STREAMING,
      {},
      { onCircuitStateChange },
    );
    this.localChatExecutor = new ResilienceExecutor(
      POLICIES.INFERENCE_LOCAL,
      {},
      { onCircuitStateChange },
    );
    this.localStreamExecutor = new ResilienceExecutor(
      POLICIES.INFERENCE_STREAMING_LOCAL,
      {},
      { onCircuitStateChange },
    );
    this.embeddingsExecutor = new ResilienceExecutor(
      POLICIES.EMBEDDINGS,
      {},
      { onCircuitStateChange },
    );
  }

  /**
   * Wraps the call in a span using OpenTelemetry's GenAI conventions.
   *
   * The name and attributes follow the Semantic Conventions for Generative AI
   * rather than a convention of our own: that is what makes the telemetry
   * readable by any observability tool without a translator (ADR-009).
   */
  private async traced<T>(
    operation: string,
    deployment: Deployment,
    request: ChatRequestInput | undefined,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    // `{operation} {model}` is the name the GenAI conventions recommend.
    return this.tracer.startActiveSpan(
      `${operation} ${deployment.model}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [GEN_AI_ATTR.OPERATION_NAME]: operation,
          [GEN_AI_ATTR.SYSTEM]: deployment.provider,
          [GEN_AI_ATTR.REQUEST_MODEL]: deployment.model,
          [AIA_ATTR.DEPLOYMENT_ID]: deployment.id,
          [AIA_ATTR.DATA_ZONE]: deployment.dataZone,
          ...(request !== undefined && {
            [GEN_AI_ATTR.REQUEST_MAX_TOKENS]: request.maxOutputTokens,
            ...(request.temperature !== undefined && {
              [GEN_AI_ATTR.REQUEST_TEMPERATURE]: request.temperature,
            }),
          }),
        },
      },
      async (span) => {
        try {
          return await fn(span);
        } catch (error) {
          recordSpanError(span, error, (error as { code?: string }).code);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Resilience policy chosen by ZONE.
   *
   * A local model loads from disk on the first call, which blows the
   * time-to-first-token budget designed for a cloud provider. Picking the policy
   * by zone solves that without loosening the limit for remote providers.
   */
  private executorFor(deployment: Deployment, streaming: boolean): ResilienceExecutor {
    if (deployment.dataZone === 'local') {
      return streaming ? this.localStreamExecutor : this.localChatExecutor;
    }
    return streaming ? this.streamExecutor : this.chatExecutor;
  }

  /** Deployments whose provider is configured. With no key, a provider vanishes. */
  private usable(deployments: readonly Deployment[]): Deployment[] {
    return deployments.filter((deployment) => {
      const provider = this.byProvider.get(deployment.provider);
      return provider?.configured === true;
    });
  }

  circuitStateOf(deploymentId: string): string | undefined {
    return this.chatExecutor.circuitState(deploymentId);
  }

  async chat(
    request: ChatRequestInput,
    deployments: readonly Deployment[],
    options: { stream: false },
  ): Promise<ChatAttempt> {
    void options;
    const candidates = this.usable(deployments);
    let attempts = 0;
    let lastError: unknown;

    for (const deployment of candidates) {
      const provider = this.byProvider.get(deployment.provider);
      if (provider === undefined) continue;
      attempts += 1;

      try {
        const result = await this.traced(GEN_AI_SPAN.CHAT, deployment, request, (span) =>
          this.executorFor(deployment, false)
            .execute(
              (signal) =>
                provider.chat(
                  {
                    ...request,
                    maxOutputTokens: deployment.clampOutputTokens(request.maxOutputTokens),
                  },
                  deployment,
                  signal,
                ),
              { key: deployment.id },
            )
            .then((chatResult) => {
              span.setAttributes({
                [GEN_AI_ATTR.RESPONSE_MODEL]: deployment.model,
                [GEN_AI_ATTR.USAGE_INPUT_TOKENS]: chatResult.usage.promptTokens,
                [GEN_AI_ATTR.USAGE_OUTPUT_TOKENS]: chatResult.usage.completionTokens,
                ...(chatResult.finishReason !== null && {
                  [GEN_AI_ATTR.RESPONSE_FINISH_REASONS]: [chatResult.finishReason],
                }),
                ...(chatResult.providerResponseId !== undefined && {
                  [GEN_AI_ATTR.RESPONSE_ID]: chatResult.providerResponseId,
                }),
              });
              return chatResult;
            }),
        );
        return { deployment, result, attempts };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `deployment ${deployment.id} failed (${describe(error)}); trying the next one`,
        );
      }
    }

    throw new AllDeploymentsFailedError(
      deployments[0]?.id ?? 'unknown',
      attempts,
      describe(lastError),
    );
  }

  /**
   * Opens the stream, walking the deployments until one answers.
   *
   * The first chunk is consumed here rather than by the caller: that is the only
   * way to know whether the provider really responded before giving up on it. It
   * is replayed into the returned iterator so no token is lost.
   */
  async openStream(
    request: ChatRequestInput,
    deployments: readonly Deployment[],
  ): Promise<OpenedStream> {
    const candidates = this.usable(deployments);
    let attempts = 0;
    let lastError: unknown;

    for (const deployment of candidates) {
      const provider = this.byProvider.get(deployment.provider);
      if (provider === undefined) continue;
      attempts += 1;

      try {
        const chunks = await this.traced(GEN_AI_SPAN.CHAT, deployment, request, () =>
          this.executorFor(deployment, true).execute(
            async (signal) => {
              const iterator = provider
                .chatStream(
                  {
                    ...request,
                    maxOutputTokens: deployment.clampOutputTokens(request.maxOutputTokens),
                  },
                  deployment,
                  signal,
                )
                [Symbol.asyncIterator]();

              const first = await iterator.next();
              return { iterator, first };
            },
            { key: deployment.id },
          ),
        );

        return { deployment, chunks: replay(chunks.first, chunks.iterator), attempts };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `stream for ${deployment.id} did not open (${describe(error)}); trying the next one`,
        );
      }
    }

    throw new AllDeploymentsFailedError(
      deployments[0]?.id ?? 'unknown',
      attempts,
      describe(lastError),
    );
  }

  async embed(
    input: string[],
    deployments: readonly Deployment[],
  ): Promise<{ deployment: Deployment; result: EmbeddingsResult; attempts: number }> {
    // Only across deployments of the SAME vector width. A chat answer from
    // another model is still an answer; an embedding of another width is a
    // vector nothing can search against. Anchored on what can actually run,
    // because a provider with no key is not a candidate for anything.
    const candidates = sameWidth(this.usable(deployments));
    let attempts = 0;
    let lastError: unknown;

    for (const deployment of candidates) {
      const provider = this.byProvider.get(deployment.provider);
      if (provider === undefined) continue;
      attempts += 1;

      try {
        const result = await this.traced(GEN_AI_SPAN.EMBEDDINGS, deployment, undefined, (span) =>
          this.embeddingsExecutor
            .execute((signal) => provider.embed(input, deployment, signal), { key: deployment.id })
            .then((embedResult) => {
              span.setAttribute(GEN_AI_ATTR.USAGE_INPUT_TOKENS, embedResult.usage.promptTokens);
              return embedResult;
            }),
        );
        return { deployment, result, attempts };
      } catch (error) {
        lastError = error;
      }
    }

    throw new AllDeploymentsFailedError(
      deployments[0]?.id ?? 'unknown',
      attempts,
      describe(lastError),
    );
  }
}

/** Replays the first chunk, already consumed to validate that the stream opened. */
async function* replay(
  first: IteratorResult<ChatChunk>,
  iterator: AsyncIterator<ChatChunk>,
): AsyncGenerator<ChatChunk> {
  if (first.done === true) return;
  yield first.value;

  for (;;) {
    const next = await iterator.next();
    if (next.done === true) return;
    yield next.value;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

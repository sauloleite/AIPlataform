import { Inject, Injectable, Logger } from '@nestjs/common';
import { SpanKind, type Span } from '@opentelemetry/api';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';
import { AIA_ATTR, GEN_AI_ATTR, GEN_AI_SPAN, getTracer, recordSpanError } from '@aia/telemetry';
import { AllDeploymentsFailedError } from '../../domain/errors/index.js';
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
 * Balanceamento por prioridade, failover e circuit breaker por deployment.
 *
 * E o que um AI Gateway gerenciado entregaria pronto. Sem cloud, e nosso — e
 * fica aqui, sobre o port `ModelProvider`, para continuar testavel sem rede
 * (ADR-012).
 *
 * Streaming tem uma regra propria: a troca de deployment so vale ANTES do
 * primeiro token. Depois disso o cliente ja recebeu conteudo, e recomecar
 * duplicaria a resposta (doc 02, secao 8).
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
   * Tracer proprio do executor.
   *
   * A instrumentacao das chamadas de modelo fica AQUI, e nao em cada adapter:
   * assim os quatro provedores emitem exatamente os mesmos atributos, e um
   * provedor novo herda a telemetria correta sem que ninguem precise lembrar.
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
      this.logger.warn(`circuito de ${key}: ${from} -> ${to}`);
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
   * Envolve a chamada em um span com as convencoes GenAI do OpenTelemetry.
   *
   * O nome e os atributos seguem as Semantic Conventions for Generative AI, e
   * nao um padrao nosso: e o que torna a telemetria legivel por qualquer
   * ferramenta de observabilidade sem tradutor (ADR-009).
   */
  private async traced<T>(
    operation: string,
    deployment: Deployment,
    request: ChatRequestInput | undefined,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    // `{operation} {model}` e o nome recomendado pelas convencoes GenAI.
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
   * Politica de resiliencia por ZONA.
   *
   * Um modelo local carrega do disco na primeira chamada, o que estoura o teto
   * de tempo ate o primeiro token pensado para provedor em nuvem. Escolher a
   * politica pela zona resolve isso sem afrouxar o limite de quem esta remoto.
   */
  private executorFor(deployment: Deployment, streaming: boolean): ResilienceExecutor {
    if (deployment.dataZone === 'local') {
      return streaming ? this.localStreamExecutor : this.localChatExecutor;
    }
    return streaming ? this.streamExecutor : this.chatExecutor;
  }

  /** Deployment cujo provedor esta configurado. Sem chave, o provedor some. */
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
          `deployment ${deployment.id} falhou (${describe(error)}); tentando o proximo`,
        );
      }
    }

    throw new AllDeploymentsFailedError(
      deployments[0]?.id ?? 'desconhecido',
      attempts,
      describe(lastError),
    );
  }

  /**
   * Abre o stream percorrendo os deployments ate um responder.
   *
   * O primeiro chunk e consumido aqui, e nao no chamador: e o unico jeito de
   * saber se o provedor realmente respondeu antes de desistir dele. Ele e
   * reinjetado no iterador devolvido para que nenhum token se perca.
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
          `stream de ${deployment.id} nao abriu (${describe(error)}); tentando o proximo`,
        );
      }
    }

    throw new AllDeploymentsFailedError(
      deployments[0]?.id ?? 'desconhecido',
      attempts,
      describe(lastError),
    );
  }

  async embed(
    input: string[],
    deployments: readonly Deployment[],
  ): Promise<{ deployment: Deployment; result: EmbeddingsResult; attempts: number }> {
    const candidates = this.usable(deployments);
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
      deployments[0]?.id ?? 'desconhecido',
      attempts,
      describe(lastError),
    );
  }
}

/** Reinjeta o primeiro chunk, ja consumido para validar a abertura do stream. */
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

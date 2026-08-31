import { Injectable } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import { IngestionFailedError } from '../../domain/errors/index.js';
import type { EmbeddingBatch, EmbeddingClient } from '../../application/ports.js';

interface EmbeddingsResponse {
  data?: { embedding?: number[] }[];
  /** The ALIAS the caller asked for, echoed back OpenAI-style. */
  model?: string;
  /** The router's own envelope: which deployment actually served the call. */
  aia?: { provider_model?: string };
}

/**
 * Embeddings through aia-inference-router.
 *
 * Never straight to a provider: routing by data classification, the budget
 * reservation and the audit record all live in the router, and ingestion is
 * subject to them exactly as chat is. The CALLER's token is used, so the spend
 * lands on the project that uploaded the document.
 */
@Injectable()
export class HttpEmbeddingClient implements EmbeddingClient {
  // POLICIES.INFERENCE, not INTERNAL. Embedding is a model call: the router
  // still has to reserve budget, pick a deployment and wait for a provider,
  // and a local model on a cold start is nowhere near two seconds. Under
  // INTERNAL the timeouts tripped the circuit breaker and every search after
  // that answered `circuit_open` without trying.
  private readonly executor = new ResilienceExecutor(POLICIES.INFERENCE);

  constructor(
    private readonly routerUrl: string,
    readonly maxBatchSize: number,
  ) {}

  async embed(input: {
    projectId: string;
    accessToken: string;
    alias: string;
    texts: readonly string[];
  }): Promise<EmbeddingBatch> {
    const body = await this.executor.execute<EmbeddingsResponse>(async (signal) => {
      const response = await fetch(`${this.routerUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Project-Id': input.projectId,
          Authorization: `Bearer ${input.accessToken}`,
        },
        body: JSON.stringify({ model: input.alias, input: [...input.texts] }),
        signal,
      });

      if (!response.ok) {
        throw new IngestionFailedError(
          `the embedding alias "${input.alias}" answered ${response.status.toString()}`,
        );
      }
      return (await response.json()) as EmbeddingsResponse;
    });

    return {
      vectors: (body.data ?? []).map((entry) => entry.embedding ?? []),
      // The PROVIDER model, not the alias: an alias can fail over between
      // deployments, and what a store pins has to be the thing that decides
      // the vector width.
      model: body.aia?.provider_model ?? body.model ?? input.alias,
    };
  }
}

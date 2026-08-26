import type { ChatCompletionResult, EmbeddingsResult } from '../../application/dto.js';

/**
 * Traduz o resultado do caso de uso para a forma da API da OpenAI.
 *
 * O bloco `aia` e a nossa extensao: diz qual deployment atendeu e em qual zona
 * de dados, o que serve de evidencia de residencia e de diagnostico. Um cliente
 * OpenAI padrao simplesmente ignora esse campo.
 */
export function toChatCompletionResponse(result: ChatCompletionResult): Record<string, unknown> {
  return {
    id: result.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.totalTokens,
    },
    aia: {
      deployment_id: result.routing.deploymentId,
      provider: result.routing.provider,
      provider_model: result.routing.providerModel,
      data_zone: result.routing.dataZone,
      cost: result.routing.cost.toJSON(),
      cache_hit: result.routing.cacheHit,
      policy_stale: result.routing.policyStale,
      budget_unverified: result.routing.budgetUnverified,
      attempts: result.routing.attempts,
    },
  };
}

export function toEmbeddingsResponse(result: EmbeddingsResult): Record<string, unknown> {
  return {
    object: 'list',
    data: result.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model: result.model,
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.totalTokens,
    },
    aia: {
      deployment_id: result.routing.deploymentId,
      provider: result.routing.provider,
      provider_model: result.routing.providerModel,
      data_zone: result.routing.dataZone,
      cost: result.routing.cost.toJSON(),
      attempts: result.routing.attempts,
    },
  };
}

import type { ChatCompletionResult, EmbeddingsResult } from '../../application/dto.js';

/**
 * Translates the use case result into the shape of the OpenAI API.
 *
 * The `aia` block is our extension: it states which deployment served the call
 * and in which data zone, which doubles as residency evidence and as
 * diagnostics. A stock OpenAI client simply ignores the field.
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
        message: {
          role: 'assistant',
          content: result.content,
          ...(result.toolCalls !== undefined && {
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
              // Handed straight back to the caller, who has to return it on
              // the next turn or the provider refuses it.
              ...(call.providerState !== undefined && { provider_state: call.providerState }),
            })),
          }),
        },
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
      guardrails_unverified: result.routing.guardrailsUnverified,
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

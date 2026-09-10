import type { Cost, DataClassification, DataZone, ProviderName } from '../value-objects/index.js';

export type UsageStatus = 'completed' | 'partial' | 'failed';

/**
 * The accomplished fact of an inference call.
 *
 * It feeds analytics (cost per project, alias and user) and stands as data
 * residency evidence: `data_zone` says where the content was processed.
 */
export interface UsageRecorded {
  requestId: string;
  projectId: string;
  principalId: string;
  alias: string;
  provider: ProviderName;
  providerModel: string;
  deploymentId: string;
  dataZone: DataZone;
  dataClassification: DataClassification;
  promptTokens: number;
  completionTokens: number;
  cost: Cost;
  durationMs: number;
  timeToFirstTokenMs?: number;
  cacheHit: boolean;
  status: UsageStatus;
  errorCode?: string;
  budgetUnverified: boolean;
  guardrailsUnverified: boolean;
  policyStale: boolean;
  occurredAt: Date;
}

/** Converts to the event payload (snake_case, matching the AsyncAPI contract). */
export function usageRecordedPayload(usage: UsageRecorded): Record<string, unknown> {
  return {
    request_id: usage.requestId,
    project_id: usage.projectId,
    principal_id: usage.principalId,
    alias: usage.alias,
    provider: usage.provider,
    provider_model: usage.providerModel,
    deployment_id: usage.deploymentId,
    data_zone: usage.dataZone,
    data_classification: usage.dataClassification,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    cost_micros: Number(usage.cost.micros),
    currency: usage.cost.currency,
    duration_ms: usage.durationMs,
    time_to_first_token_ms: usage.timeToFirstTokenMs ?? null,
    cache_hit: usage.cacheHit,
    status: usage.status,
    error_code: usage.errorCode ?? null,
    budget_unverified: usage.budgetUnverified,
    guardrails_unverified: usage.guardrailsUnverified,
    policy_stale: usage.policyStale,
  };
}

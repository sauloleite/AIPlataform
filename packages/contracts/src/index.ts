/**
 * The platform contracts.
 *
 * The types under `generated/` come from the OpenAPI files and are never edited
 * by hand. The aliases below exist so application code does not have to navigate
 * the generator's `components.schemas` tree.
 */
export type * from './generated/index.js';

/**
 * The one RUNTIME value this package exports, and it earns it.
 *
 * ADR-010's rule -- which data zones a classification may reach -- had been
 * written out four times: here in `packages/auth`, in `python/aia_auth`, in
 * aia-governance's domain and in the console's. Four independent copies of the
 * rule that decides whether restricted data may leave the machine, with nothing
 * comparing them (ADR-027). It is generated from `_shared.yaml` now, into both
 * languages, and CI fails if either drifts.
 */
export {
  CLASSIFICATIONS,
  DATA_ZONES,
  MAX_ZONES_BY_CLASSIFICATION,
  type Classification,
  type DataZone,
} from './generated/data-zones.js';

import type { components as InferenceComponents } from './generated/inference-router.js';
import type { components as GovernanceComponents } from './generated/governance.js';
import type { components as IdentityComponents } from './generated/identity.js';
import type { components as GuardrailsComponents } from './generated/guardrails.js';

export type ChatCompletionRequest = InferenceComponents['schemas']['ChatCompletionRequest'];
export type ChatCompletion = InferenceComponents['schemas']['ChatCompletion'];
export type ChatMessage = InferenceComponents['schemas']['ChatMessage'];
export type EmbeddingsRequest = InferenceComponents['schemas']['EmbeddingsRequest'];
export type EmbeddingsResponse = InferenceComponents['schemas']['EmbeddingsResponse'];
export type ModelAliasDto = InferenceComponents['schemas']['ModelAlias'];
export type RoutingMetadata = InferenceComponents['schemas']['RoutingMetadata'];
export type Usage = InferenceComponents['schemas']['Usage'];

export type ProjectDto = GovernanceComponents['schemas']['Project'];
export type CreateProjectRequest = GovernanceComponents['schemas']['CreateProjectRequest'];
export type BudgetDto = GovernanceComponents['schemas']['Budget'];
export type SetBudgetRequest = GovernanceComponents['schemas']['SetBudgetRequest'];
export type ProjectPolicyDto = GovernanceComponents['schemas']['ProjectPolicy'];
export type ModelRuleDto = GovernanceComponents['schemas']['ModelRule'];

export type PrincipalDto = IdentityComponents['schemas']['Principal'];
export type TokenResponse = IdentityComponents['schemas']['TokenResponse'];
export type PatDto = IdentityComponents['schemas']['Pat'];

export type AnalyzeRequest = GuardrailsComponents['schemas']['AnalyzeRequest'];
export type AnalyzeResponse = GuardrailsComponents['schemas']['AnalyzeResponse'];
export type RedactRequest = GuardrailsComponents['schemas']['RedactRequest'];
export type RedactResponse = GuardrailsComponents['schemas']['RedactResponse'];
export type Finding = GuardrailsComponents['schemas']['Finding'];

/**
 * Types describing the SSE protocol. They do not come from OpenAPI because the
 * body of a `text/event-stream` is not described by a JSON schema.
 */
export type SseEventName = 'message.delta' | 'run.finished' | 'error' | 'ping';

export interface SseMessageDelta {
  index: number;
  delta: { role?: string; content?: string };
  finish_reason?: string | null;
}

export interface SseRunFinished {
  id: string;
  model: string;
  usage: Usage;
  aia: RoutingMetadata;
}

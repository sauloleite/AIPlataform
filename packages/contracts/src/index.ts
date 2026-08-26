/**
 * Contratos da plataforma.
 *
 * Os tipos em `generated/` saem dos arquivos OpenAPI e nunca sao editados a mao.
 * Os apelidos abaixo existem para que o codigo de aplicacao nao precise navegar
 * a arvore `components.schemas` do gerador.
 */
export type * from './generated/index.js';

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
 * Tipos que descrevem o protocolo SSE. Nao vem do OpenAPI porque o corpo de um
 * `text/event-stream` nao e descrito por schema JSON.
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

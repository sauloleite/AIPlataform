import { Deployment } from '../src/modules/completions/domain/entities/deployment.js';
import { ModelAlias } from '../src/modules/completions/domain/entities/model-alias.js';
import type { ProjectPolicySnapshot } from '../src/modules/completions/domain/services/model-selection-policy.js';
import type { Capability } from '../src/modules/completions/domain/entities/model-alias.js';
import type {
  DataClassification,
  DataZone,
  ProviderName,
} from '../src/modules/completions/domain/value-objects/index.js';

/** Test builders. They exist so each test states only what matters to it. */

export function aDeployment(
  overrides: Partial<{
    id: string;
    provider: ProviderName;
    model: string;
    dataZone: DataZone;
    priority: number;
    inputCostPerMillion: bigint;
    outputCostPerMillion: bigint;
    currency: string;
    maxOutputTokens: number;
    dimensions: number;
    enabled: boolean;
    deprecatedAt: Date;
  }> = {},
): Deployment {
  return new Deployment({
    id: overrides.id ?? 'dep-1',
    provider: overrides.provider ?? 'ollama',
    model: overrides.model ?? 'llama3.2:3b',
    dataZone: overrides.dataZone ?? 'local',
    priority: overrides.priority ?? 0,
    ...(overrides.dimensions !== undefined && { dimensions: overrides.dimensions }),
    inputCostPerMillion: overrides.inputCostPerMillion ?? 0n,
    outputCostPerMillion: overrides.outputCostPerMillion ?? 0n,
    currency: overrides.currency ?? 'BRL',
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    enabled: overrides.enabled ?? true,
    ...(overrides.deprecatedAt !== undefined && { deprecatedAt: overrides.deprecatedAt }),
  });
}

export function anAlias(
  deployments: Deployment[],
  overrides: { id?: string; capabilities?: Capability[] } = {},
): ModelAlias {
  return ModelAlias.of({
    id: overrides.id ?? 'chat-fast',
    capabilities: overrides.capabilities ?? ['chat'],
    deployments,
  });
}

export function aPolicy(
  overrides: Partial<{
    projectId: string;
    classification: DataClassification;
    allowedZones: DataZone[];
    blockedAliases: string[];
    maxOutputTokens: Record<string, number>;
  }> = {},
): ProjectPolicySnapshot {
  const blocked = overrides.blockedAliases ?? [];
  const limits = overrides.maxOutputTokens ?? {};
  return {
    projectId: overrides.projectId ?? 'proj-1',
    classification: overrides.classification ?? 'internal',
    allowedZones: overrides.allowedZones ?? ['local', 'br', 'us', 'eu', 'global'],
    isAliasAllowed: (alias) => !blocked.includes(alias),
    maxOutputTokensFor: (alias) => limits[alias],
  };
}

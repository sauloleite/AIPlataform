import { Inject, Injectable } from '@nestjs/common';
import { ModelSelectionPolicy } from '../../domain/services/model-selection-policy.js';
import { ALIAS_REGISTRY, POLICY_READER, type AliasRegistry, type PolicyReader } from '../ports.js';

export interface ModelAliasView {
  id: string;
  object: 'model';
  description?: string;
  capabilities: string[];
  max_output_tokens: number;
  data_zones: string[];
  deprecated_at: string | null;
}

/**
 * Catalogo visivel ao projeto.
 *
 * Alias sem nenhum deployment compativel com a classificacao simplesmente nao
 * aparece: melhor nao oferecer do que oferecer e recusar na hora do uso.
 */
@Injectable()
export class ListModels {
  constructor(
    @Inject(ALIAS_REGISTRY) private readonly aliases: AliasRegistry,
    @Inject(POLICY_READER) private readonly policies: PolicyReader,
  ) {}

  async execute(projectId: string): Promise<ModelAliasView[]> {
    const [all, policyResult] = await Promise.all([
      this.aliases.all(),
      this.policies.forProject(projectId),
    ]);

    return ModelSelectionPolicy.visibleAliases(all, policyResult.policy).map((alias) => {
      const usable = alias.deployments.filter(
        (deployment) =>
          deployment.enabled && policyResult.policy.allowedZones.includes(deployment.dataZone),
      );
      const nearestRetirement = usable
        .map((deployment) => deployment.deprecatedAt)
        .filter((date): date is Date => date !== undefined)
        .sort((a, b) => a.getTime() - b.getTime())[0];

      return {
        id: alias.id,
        object: 'model' as const,
        ...(alias.description !== undefined && { description: alias.description }),
        capabilities: [...alias.capabilities],
        max_output_tokens: Math.max(...usable.map((deployment) => deployment.maxOutputTokens)),
        data_zones: [...new Set(usable.map((deployment) => deployment.dataZone))],
        deprecated_at: nearestRetirement?.toISOString() ?? null,
      };
    });
  }
}

import type { AgentDefinition, AssetVersionSummary, RegistryGateway } from '../ports';

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  definition: AgentDefinition;
}

export class CreateAgent {
  constructor(private readonly registry: RegistryGateway) {}

  execute(
    accessToken: string,
    projectId: string,
    input: CreateAgentInput,
  ): Promise<AssetVersionSummary> {
    return this.registry.createAsset(accessToken, projectId, { kind: 'agent', ...input });
  }
}

export class SaveAgentDraft {
  constructor(private readonly registry: RegistryGateway) {}

  execute(
    accessToken: string,
    projectId: string,
    assetId: string,
    input: { definition: AgentDefinition; expectedVersion: number; name?: string },
  ): Promise<AssetVersionSummary> {
    return this.registry.updateDraft(accessToken, projectId, assetId, input);
  }
}

export class PublishAgent {
  constructor(private readonly registry: RegistryGateway) {}

  execute(accessToken: string, projectId: string, assetId: string): Promise<AssetVersionSummary> {
    return this.registry.publish(accessToken, projectId, assetId);
  }
}

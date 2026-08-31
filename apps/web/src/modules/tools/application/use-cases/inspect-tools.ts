import type { Binding, EffectiveTool, ToolsGateway } from '../ports';

export interface ToolCard extends EffectiveTool {
  bound: true;
}

/** A tool published in the registry that this project has not allowed yet. */
export interface UnboundToolCard {
  toolId: string;
  bound: false;
}

export class ListTools {
  constructor(private readonly tools: ToolsGateway) {}

  async execute(
    accessToken: string,
    projectId: string,
  ): Promise<{ tools: ToolCard[]; bindings: Binding[] }> {
    const [effective, bindings] = await Promise.all([
      this.tools.listEffective(accessToken, projectId),
      this.tools.listBindings(accessToken, projectId),
    ]);

    return { tools: effective.map((tool) => ({ ...tool, bound: true })), bindings };
  }
}

export class BindTool {
  constructor(private readonly tools: ToolsGateway) {}

  execute(
    accessToken: string,
    projectId: string,
    toolId: string,
    input: { enabled: boolean; rateLimitPerMinute?: number; requireApproval?: boolean },
  ): Promise<Binding> {
    return this.tools.bind(accessToken, projectId, toolId, input);
  }
}

export class UnbindTool {
  constructor(private readonly tools: ToolsGateway) {}

  execute(accessToken: string, projectId: string, toolId: string): Promise<void> {
    return this.tools.unbind(accessToken, projectId, toolId);
  }
}

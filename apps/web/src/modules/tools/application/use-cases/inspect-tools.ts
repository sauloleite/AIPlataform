import type { Binding, BuiltinTool, EffectiveTool, ToolsGateway } from '../ports';

export interface ToolCard extends EffectiveTool {
  bound: true;
}

export interface ToolsView {
  /** Every built-in, including the ones this project cannot use and why. */
  builtins: BuiltinTool[];
  /** Tools this project's people defined in the registry and allowed here. */
  projectTools: ToolCard[];
}

export class ListTools {
  constructor(private readonly tools: ToolsGateway) {}

  async execute(accessToken: string, projectId: string): Promise<ToolsView> {
    const [builtins, effective] = await Promise.all([
      this.tools.listBuiltins(accessToken, projectId),
      this.tools.listEffective(accessToken, projectId),
    ]);

    return {
      builtins,
      // Built-ins are already listed above, with more to say about each.
      projectTools: effective
        .filter((tool) => tool.source === 'registry')
        .map((tool) => ({ ...tool, bound: true })),
    };
  }
}

/**
 * What an agent in this project may attach: everything the project may invoke,
 * built-ins first because they are what most agents start with.
 */
export class ListAttachableTools {
  constructor(private readonly tools: ToolsGateway) {}

  async execute(accessToken: string, projectId: string): Promise<EffectiveTool[]> {
    const effective = await this.tools.listEffective(accessToken, projectId);
    return [...effective].sort(
      (a, b) =>
        Number(a.source !== 'platform') - Number(b.source !== 'platform') ||
        a.name.localeCompare(b.name),
    );
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

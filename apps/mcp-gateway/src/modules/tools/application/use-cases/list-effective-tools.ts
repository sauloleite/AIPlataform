import { Inject, Injectable } from '@nestjs/common';

import { requiresApproval } from '../../domain/services/invocation-policy.js';
import type { EffectiveToolView } from '../dto.js';
import {
  BINDING_REPOSITORY,
  TOOL_CATALOG,
  type BindingRepository,
  type ToolCatalog,
} from '../ports.js';

/**
 * What this project may actually invoke.
 *
 * The registry's published tools intersected with this project's bindings: a
 * tool that exists but is not bound does not appear, because listing it would
 * suggest it can be called.
 */
@Injectable()
export class ListEffectiveTools {
  constructor(
    @Inject(TOOL_CATALOG) private readonly catalog: ToolCatalog,
    @Inject(BINDING_REPOSITORY) private readonly bindings: BindingRepository,
  ) {}

  async execute(input: { projectId: string; accessToken: string }): Promise<EffectiveToolView[]> {
    const [tools, bindings] = await Promise.all([
      this.catalog.list(input),
      this.bindings.list(input.projectId),
    ]);

    const byToolId = new Map(bindings.map((binding) => [binding.toolId, binding]));

    return tools.flatMap((tool) => {
      const binding = byToolId.get(tool.toolId);
      if (binding?.enabled !== true) return [];

      return [
        {
          toolId: tool.toolId,
          slug: tool.slug,
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          toolType: tool.toolType,
          ...(tool.builtinId !== undefined && { builtinId: tool.builtinId }),
          riskLevel: tool.riskLevel,
          requiresApproval: requiresApproval(tool.riskLevel, binding),
          rateLimitPerMinute: binding.effectiveRateLimit,
          ...(tool.parameters !== undefined && { parameters: tool.parameters }),
        },
      ];
    });
  }
}

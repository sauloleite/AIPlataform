import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@aia/auth';

import {
  dataZoneRefusal,
  isAllowedInProject,
  rateLimitFor,
  requiresApproval,
} from '../../domain/services/invocation-policy.js';
import { BUILTIN_TOOLS } from '../../domain/value-objects/builtin-tools.js';
import type { BuiltinToolView } from '../dto.js';
import {
  BINDING_REPOSITORY,
  CLASSIFICATION_READER,
  TOOL_EXECUTORS,
  type BindingRepository,
  type ClassificationReader,
  type ToolExecutor,
} from '../ports.js';
import { classificationFor, readinessOf } from '../services/tool-resolution.js';

/**
 * Every built-in, with whether this project can use it and, when not, why.
 *
 * The administrative view. `ListEffectiveTools` hides what cannot run, which is
 * right for a model and useless for the person who has to fix it: an operator
 * needs to see that web search has no backend before somebody builds an agent
 * on it, and a project owner needs a switched-off built-in listed to switch it
 * back on.
 */
@Injectable()
export class ListBuiltinTools {
  constructor(
    @Inject(BINDING_REPOSITORY) private readonly bindings: BindingRepository,
    @Inject(TOOL_EXECUTORS) private readonly executors: readonly ToolExecutor[],
    @Inject(CLASSIFICATION_READER) private readonly classifications: ClassificationReader,
  ) {}

  async execute(input: {
    projectId: string;
    accessToken: string;
    principal: Principal;
  }): Promise<BuiltinToolView[]> {
    const bindings = await this.bindings.list(input.projectId);
    const byToolId = new Map(bindings.map((binding) => [binding.toolId, binding]));
    const dataClassification = await classificationFor(this.classifications, input, BUILTIN_TOOLS);

    const views: BuiltinToolView[] = [];
    for (const tool of BUILTIN_TOOLS) {
      const binding = byToolId.get(tool.toolId) ?? null;
      // The platform's own configuration is reported first: no project setting
      // makes a missing backend work, so that is the reason worth reading.
      const reason =
        (await readinessOf(this.executors, tool)).reason ??
        dataZoneRefusal({
          principal: input.principal,
          projectId: input.projectId,
          tool,
          dataClassification,
        });

      views.push({
        toolId: tool.toolId,
        slug: tool.slug,
        name: tool.name,
        description: tool.description ?? '',
        builtinId: tool.builtinId ?? '',
        riskLevel: tool.riskLevel,
        dataZone: tool.dataZone ?? 'local',
        enabled: isAllowedInProject(tool, binding),
        available: reason === null,
        unavailableReason: reason,
        requiresApproval: requiresApproval(tool.riskLevel, binding),
        rateLimitPerMinute: rateLimitFor(binding),
        ...(tool.parameters !== undefined && { parameters: tool.parameters }),
      });
    }
    return views;
  }
}

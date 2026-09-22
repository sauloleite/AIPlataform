import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@aia/auth';

import {
  dataZoneRefusal,
  isAllowedInProject,
  rateLimitFor,
  requiresApproval,
} from '../../domain/services/invocation-policy.js';
import { BUILTIN_TOOLS } from '../../domain/value-objects/builtin-tools.js';
import type { ToolDefinition } from '../../domain/value-objects/index.js';
import type { EffectiveToolView } from '../dto.js';
import {
  BINDING_REPOSITORY,
  CLASSIFICATION_READER,
  TOOL_CATALOG,
  TOOL_EXECUTORS,
  type BindingRepository,
  type ClassificationReader,
  type ToolCatalog,
  type ToolExecutor,
} from '../ports.js';
import { classificationFor, readinessOf } from '../services/tool-resolution.js';
import type { ToolBinding } from '../../domain/entities/tool-binding.js';

/**
 * What this project may actually invoke.
 *
 * The registry's published tools intersected with this project's bindings,
 * plus the platform's built-ins. A registry tool that is not bound does not
 * appear, because listing it would suggest it can be called. For the same
 * reason a built-in does not appear when it is switched off, has no backend,
 * or would send data where the project's classification forbids.
 */
@Injectable()
export class ListEffectiveTools {
  constructor(
    @Inject(TOOL_CATALOG) private readonly catalog: ToolCatalog,
    @Inject(BINDING_REPOSITORY) private readonly bindings: BindingRepository,
    @Inject(TOOL_EXECUTORS) private readonly executors: readonly ToolExecutor[],
    @Inject(CLASSIFICATION_READER) private readonly classifications: ClassificationReader,
  ) {}

  async execute(input: {
    projectId: string;
    accessToken: string;
    principal: Principal;
  }): Promise<EffectiveToolView[]> {
    const [tools, bindings] = await Promise.all([
      this.catalog.list(input),
      this.bindings.list(input.projectId),
    ]);

    const byToolId = new Map(bindings.map((binding) => [binding.toolId, binding]));

    const registry = tools.flatMap((tool) => {
      const binding = byToolId.get(tool.toolId);
      return binding?.enabled === true ? [toView(tool, binding)] : [];
    });

    // A registry tool keeps its slug. Agents already attached to it were built
    // against that tool, and two declarations with one name would leave the
    // model -- and the runtime mapping its call back -- to guess.
    const taken = new Set(registry.map((tool) => tool.slug));
    const builtins = await this.usableBuiltins(input, byToolId);

    return [...registry, ...builtins.filter((tool) => !taken.has(tool.slug))];
  }

  private async usableBuiltins(
    input: { projectId: string; accessToken: string; principal: Principal },
    byToolId: ReadonlyMap<string, ToolBinding>,
  ): Promise<EffectiveToolView[]> {
    const allowed = BUILTIN_TOOLS.filter((tool) =>
      isAllowedInProject(tool, byToolId.get(tool.toolId) ?? null),
    );

    const ready: ToolDefinition[] = [];
    for (const tool of allowed) {
      if ((await readinessOf(this.executors, tool)).reason === null) ready.push(tool);
    }

    const dataClassification = await classificationFor(this.classifications, input, ready);

    return ready
      .filter(
        (tool) =>
          dataZoneRefusal({
            principal: input.principal,
            projectId: input.projectId,
            tool,
            dataClassification,
          }) === null,
      )
      .map((tool) => toView(tool, byToolId.get(tool.toolId) ?? null));
  }
}

function toView(tool: ToolDefinition, binding: ToolBinding | null): EffectiveToolView {
  return {
    toolId: tool.toolId,
    slug: tool.slug,
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    toolType: tool.toolType,
    source: tool.source,
    ...(tool.builtinId !== undefined && { builtinId: tool.builtinId }),
    riskLevel: tool.riskLevel,
    requiresApproval: requiresApproval(tool.riskLevel, binding),
    rateLimitPerMinute: rateLimitFor(binding),
    ...(tool.parameters !== undefined && { parameters: tool.parameters }),
  };
}

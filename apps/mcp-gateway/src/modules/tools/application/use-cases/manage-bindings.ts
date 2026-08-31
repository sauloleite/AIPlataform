import { Inject, Injectable } from '@nestjs/common';

import { ToolBinding } from '../../domain/entities/tool-binding.js';
import { ToolNotFoundError } from '../../domain/errors/index.js';
import type { BindToolCommand, BindingView } from '../dto.js';
import {
  BINDING_REPOSITORY,
  CLOCK,
  TOOL_CATALOG,
  type BindingRepository,
  type Clock,
  type ToolCatalog,
} from '../ports.js';

function toView(binding: ToolBinding): BindingView {
  const props = binding.snapshot();
  return {
    projectId: props.projectId,
    toolId: props.toolId,
    enabled: props.enabled,
    rateLimitPerMinute: props.rateLimitPerMinute ?? null,
    requireApproval: props.requireApproval ?? null,
    updatedAt: props.updatedAt.toISOString(),
  };
}

@Injectable()
export class ListBindings {
  constructor(@Inject(BINDING_REPOSITORY) private readonly bindings: BindingRepository) {}

  async execute(projectId: string): Promise<BindingView[]> {
    return (await this.bindings.list(projectId)).map(toView);
  }
}

@Injectable()
export class BindTool {
  constructor(
    @Inject(TOOL_CATALOG) private readonly catalog: ToolCatalog,
    @Inject(BINDING_REPOSITORY) private readonly bindings: BindingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: BindToolCommand): Promise<BindingView> {
    // Binding a tool that does not exist would create an allow-list entry
    // nothing can ever match, and hide the typo until somebody debugs a run.
    const tool = await this.catalog.find({
      projectId: command.projectId,
      accessToken: command.accessToken,
      toolId: command.toolId,
    });
    if (tool === null) throw new ToolNotFoundError(command.toolId);

    const binding = ToolBinding.create({
      projectId: command.projectId,
      toolId: command.toolId,
      ...(command.enabled !== undefined && { enabled: command.enabled }),
      ...(command.rateLimitPerMinute !== undefined && {
        rateLimitPerMinute: command.rateLimitPerMinute,
      }),
      ...(command.requireApproval !== undefined && { requireApproval: command.requireApproval }),
      now: this.clock.now(),
    });

    await this.bindings.save(binding);
    return toView(binding);
  }
}

@Injectable()
export class UnbindTool {
  constructor(@Inject(BINDING_REPOSITORY) private readonly bindings: BindingRepository) {}

  async execute(projectId: string, toolId: string): Promise<void> {
    await this.bindings.remove(projectId, toolId);
  }
}

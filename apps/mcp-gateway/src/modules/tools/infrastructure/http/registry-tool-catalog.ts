import { Injectable, Logger } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import type { ToolCatalog } from '../../application/ports.js';
import type { ToolDefinition, ToolType } from '../../domain/value-objects/index.js';

/** The registry's contract shape, snake_case. See contracts/openapi/registry.v1.yaml. */
interface RawAsset {
  id: string;
  kind: string;
  slug: string;
  name: string;
  description?: string;
  published_version?: number | null;
}

interface RawVersion {
  definition?: {
    kind?: string;
    tool_type?: ToolType;
    risk_level?: 'low' | 'medium' | 'high';
    endpoint?: string;
    builtin_id?: string;
    parameters?: Record<string, unknown>;
    connection_id?: string;
  };
}

/**
 * Tool definitions read from aia-registry, over the contract.
 *
 * Only PUBLISHED versions: an unpublished draft is somebody's work in
 * progress, and invoking it would be running a definition nobody released.
 */
@Injectable()
export class RegistryToolCatalog implements ToolCatalog {
  private readonly logger = new Logger(RegistryToolCatalog.name);
  private readonly executor = new ResilienceExecutor(POLICIES.INTERNAL);

  constructor(private readonly registryUrl: string) {}

  async find(input: {
    projectId: string;
    accessToken: string;
    toolId: string;
  }): Promise<ToolDefinition | null> {
    const asset = await this.get<RawAsset>(`/v1/assets/${encodeURIComponent(input.toolId)}`, input);
    if (asset?.kind !== 'tool') return null;

    const version = await this.get<RawVersion>(
      `/v1/assets/${encodeURIComponent(input.toolId)}/published`,
      input,
    );
    if (version === null) return null;

    return toDefinition(asset, version);
  }

  async list(input: { projectId: string; accessToken: string }): Promise<ToolDefinition[]> {
    const page = await this.get<{ items?: RawAsset[] }>('/v1/assets?kind=tool&limit=200', input);
    if (page === null) return [];

    const tools: ToolDefinition[] = [];
    for (const asset of page.items ?? []) {
      // Nothing published means nothing to invoke.
      if ((asset.published_version ?? null) === null) continue;

      const version = await this.get<RawVersion>(
        `/v1/assets/${encodeURIComponent(asset.id)}/published`,
        input,
      );
      if (version === null) continue;

      const definition = toDefinition(asset, version);
      if (definition !== null) tools.push(definition);
    }
    return tools;
  }

  private async get<T>(
    path: string,
    auth: { projectId: string; accessToken: string },
  ): Promise<T | null> {
    try {
      return await this.executor.execute<T | null>(async (signal) => {
        const response = await fetch(`${this.registryUrl}${path}`, {
          headers: {
            Accept: 'application/json',
            'X-Project-Id': auth.projectId,
            Authorization: `Bearer ${auth.accessToken}`,
          },
          signal,
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`registry answered ${response.status.toString()}`);
        return (await response.json()) as T;
      });
    } catch (error) {
      // A catalogue that cannot be reached must not be read as "no such tool",
      // or a registry outage would silently look like an empty allow-list.
      this.logger.error(`could not read the tool catalogue: ${String(error)}`);
      throw error;
    }
  }
}

function toDefinition(asset: RawAsset, version: RawVersion): ToolDefinition | null {
  const definition = version.definition;
  if (definition?.kind !== 'tool') return null;
  if (definition.tool_type === undefined || definition.risk_level === undefined) return null;

  return {
    toolId: asset.id,
    slug: asset.slug,
    name: asset.name,
    ...(asset.description !== undefined && { description: asset.description }),
    toolType: definition.tool_type,
    riskLevel: definition.risk_level,
    ...(definition.endpoint !== undefined && { endpoint: definition.endpoint }),
    ...(definition.builtin_id !== undefined && { builtinId: definition.builtin_id }),
    ...(definition.parameters !== undefined && { parameters: definition.parameters }),
    ...(definition.connection_id !== undefined && { connectionId: definition.connection_id }),
  };
}

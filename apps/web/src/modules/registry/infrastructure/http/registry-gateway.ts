import { PlatformError, type ProblemDetails } from '../../../console/domain/errors';
import type {
  AssetDefinition,
  AssetDetail,
  AssetKind,
  AssetSummary,
  AssetVersionSummary,
  CreateAssetInput,
  RegistryGateway,
} from '../../application/ports';

/**
 * aia-registry reached over HTTP.
 *
 * Server-side only: it takes the access token as an argument, and a token that
 * reaches the browser is a token an XSS can read.
 *
 * The contract is snake_case, the console is camelCase. Translating here keeps
 * the wire shape out of every page.
 */
export class HttpRegistryGateway implements RegistryGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async listAssets(
    accessToken: string,
    projectId: string,
    kind?: AssetKind,
  ): Promise<AssetSummary[]> {
    const query = kind === undefined ? '' : `?kind=${encodeURIComponent(kind)}`;
    const body = await this.json<{ items: RawAsset[] }>(`${this.baseUrl}/v1/assets${query}`, {
      accessToken,
      projectId,
    });
    return body.items.map(toAsset);
  }

  async getAsset(accessToken: string, projectId: string, assetId: string): Promise<AssetDetail> {
    const body = await this.json<RawAsset & { versions?: RawVersion[] }>(
      `${this.baseUrl}/v1/assets/${encodeURIComponent(assetId)}`,
      { accessToken, projectId },
    );
    return { ...toAsset(body), versions: (body.versions ?? []).map(toVersion) };
  }

  async createAsset(
    accessToken: string,
    projectId: string,
    input: CreateAssetInput,
  ): Promise<AssetVersionSummary> {
    const body = await this.json<RawVersion>(`${this.baseUrl}/v1/assets`, {
      method: 'POST',
      accessToken,
      projectId,
      body: {
        kind: input.kind,
        slug: input.slug,
        name: input.name,
        ...(input.description !== undefined && { description: input.description }),
        definition: toWireDefinition(input.definition),
      },
    });
    return toVersion(body);
  }

  async updateDraft(
    accessToken: string,
    projectId: string,
    assetId: string,
    input: { definition: AssetDefinition; expectedVersion: number; name?: string },
  ): Promise<AssetVersionSummary> {
    const body = await this.json<RawVersion>(
      `${this.baseUrl}/v1/assets/${encodeURIComponent(assetId)}/draft`,
      {
        method: 'PUT',
        accessToken,
        projectId,
        body: {
          definition: toWireDefinition(input.definition),
          expected_version: input.expectedVersion,
          ...(input.name !== undefined && { name: input.name }),
        },
      },
    );
    return toVersion(body);
  }

  async publish(
    accessToken: string,
    projectId: string,
    assetId: string,
  ): Promise<AssetVersionSummary> {
    const body = await this.json<RawVersion>(
      `${this.baseUrl}/v1/assets/${encodeURIComponent(assetId)}/versions`,
      { method: 'POST', accessToken, projectId },
    );
    return toVersion(body);
  }

  private async json<T>(
    url: string,
    options: {
      method?: string;
      accessToken?: string;
      projectId?: string;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
          ...(options.accessToken !== undefined && {
            Authorization: `Bearer ${options.accessToken}`,
          }),
          ...(options.projectId !== undefined && { 'X-Project-Id': options.projectId }),
        },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok) throw await problemFrom(response);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RawAsset {
  id: string;
  kind: AssetKind;
  slug: string;
  name: string;
  description?: string;
  published_version?: number | null;
  draft_version?: number | null;
  updated_at?: string;
}

interface RawVersion {
  asset_id: string;
  version: number;
  status: 'draft' | 'published' | 'deprecated';
  definition: Record<string, unknown>;
  published_at?: string | null;
  updated_at?: string;
  revision: number;
}

function toAsset(raw: RawAsset): AssetSummary {
  return {
    id: raw.id,
    kind: raw.kind,
    slug: raw.slug,
    name: raw.name,
    ...(raw.description !== undefined && { description: raw.description }),
    publishedVersion: raw.published_version ?? null,
    draftVersion: raw.draft_version ?? null,
    updatedAt: raw.updated_at ?? '',
  };
}

function toVersion(raw: RawVersion): AssetVersionSummary {
  return {
    assetId: raw.asset_id,
    version: raw.version,
    status: raw.status,
    definition: fromWireDefinition(raw.definition),
    ...(raw.published_at !== undefined &&
      raw.published_at !== null && { publishedAt: raw.published_at }),
    updatedAt: raw.updated_at ?? '',
    revision: raw.revision,
  };
}

/** Anything that is not a string is not a string. Coercing an object here would
 *  put `[object Object]` in front of the user instead of an empty field. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** snake_case on the wire, camelCase in the console. The inverse of below. */
function fromWireDefinition(raw: Record<string, unknown>): AssetDefinition {
  const refs = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

  if (raw['kind'] === 'tool') {
    return {
      kind: 'tool',
      toolType: raw['tool_type'] as 'mcp' | 'openapi' | 'builtin',
      riskLevel: raw['risk_level'] as 'low' | 'medium' | 'high',
      ...(typeof raw['endpoint'] === 'string' && { endpoint: raw['endpoint'] }),
      ...(typeof raw['builtin_id'] === 'string' && { builtinId: raw['builtin_id'] }),
    };
  }

  if (raw['kind'] === 'prompt') {
    return {
      kind: 'prompt',
      template: str(raw['template']),
      variables: Array.isArray(raw['variables']) ? (raw['variables'] as string[]) : [],
    };
  }

  return {
    kind: 'agent',
    instructions: str(raw['instructions']),
    modelAlias: str(raw['model_alias']),
    tools: refs(raw['tools']).map((tool) => ({
      assetId: str(tool['asset_id']),
      version: typeof tool['version'] === 'number' ? tool['version'] : null,
    })),
    knowledge: refs(raw['knowledge']).map((store) => ({ storeId: str(store['store_id']) })),
    ...(typeof raw['temperature'] === 'number' && { temperature: raw['temperature'] }),
    ...(typeof raw['top_p'] === 'number' && { topP: raw['top_p'] }),
    ...(typeof raw['max_output_tokens'] === 'number' && {
      maxOutputTokens: raw['max_output_tokens'],
    }),
  };
}

/** camelCase in the console, snake_case on the wire. */
function toWireDefinition(definition: AssetDefinition): Record<string, unknown> {
  switch (definition.kind) {
    case 'agent':
      return {
        kind: 'agent',
        instructions: definition.instructions,
        model_alias: definition.modelAlias,
        tools: definition.tools.map((t) => ({ asset_id: t.assetId, version: t.version })),
        knowledge: definition.knowledge.map((k) => ({ store_id: k.storeId })),
        ...(definition.temperature !== undefined && { temperature: definition.temperature }),
        ...(definition.topP !== undefined && { top_p: definition.topP }),
        ...(definition.maxOutputTokens !== undefined && {
          max_output_tokens: definition.maxOutputTokens,
        }),
      };
    case 'tool':
      return {
        kind: 'tool',
        tool_type: definition.toolType,
        risk_level: definition.riskLevel,
        ...(definition.endpoint !== undefined && { endpoint: definition.endpoint }),
        ...(definition.builtinId !== undefined && { builtin_id: definition.builtinId }),
      };
    case 'prompt':
      return {
        kind: 'prompt',
        template: definition.template,
        variables: definition.variables,
      };
  }
}

async function problemFrom(response: Response): Promise<PlatformError> {
  try {
    return new PlatformError((await response.json()) as ProblemDetails);
  } catch {
    // A body that is not Problem Details still has to become one, or the
    // console shows "unexpected end of JSON" where a status belongs.
    return new PlatformError({
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: 'internal_error',
    });
  }
}

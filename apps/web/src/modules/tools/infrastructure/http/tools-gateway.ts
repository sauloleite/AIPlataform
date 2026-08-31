import { PlatformError, type ProblemDetails } from '../../../console/domain/errors';
import type {
  Binding,
  ConnectionSummary,
  CreateConnectionInput,
  EffectiveTool,
  ToolsGateway,
} from '../../application/ports';

/** aia-mcp-gateway over HTTP. Server-side only. */
export class HttpToolsGateway implements ToolsGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async listConnections(accessToken: string, projectId: string): Promise<ConnectionSummary[]> {
    const body = await this.json<{ items: RawConnection[] }>(`${this.baseUrl}/v1/connections`, {
      accessToken,
      projectId,
    });
    return body.items.map(toConnection);
  }

  async createConnection(
    accessToken: string,
    projectId: string,
    input: CreateConnectionInput,
  ): Promise<ConnectionSummary> {
    const raw = await this.json<RawConnection>(`${this.baseUrl}/v1/connections`, {
      method: 'POST',
      accessToken,
      projectId,
      body: {
        slug: input.slug,
        name: input.name,
        kind: input.kind,
        ...(input.description !== undefined &&
          input.description !== '' && { description: input.description }),
        ...(input.header !== undefined && input.header !== '' && { header: input.header }),
        // A NAME. The console has no field for a value, and no route that
        // would accept one.
        ...(input.secretRef !== undefined &&
          input.secretRef !== '' && { secret_ref: input.secretRef }),
      },
    });
    return toConnection(raw);
  }

  async deleteConnection(
    accessToken: string,
    projectId: string,
    connectionId: string,
  ): Promise<void> {
    await this.json<undefined>(
      `${this.baseUrl}/v1/connections/${encodeURIComponent(connectionId)}`,
      { method: 'DELETE', accessToken, projectId },
    );
  }

  async listEffective(accessToken: string, projectId: string): Promise<EffectiveTool[]> {
    const body = await this.json<{ items: RawTool[] }>(`${this.baseUrl}/v1/tools`, {
      accessToken,
      projectId,
    });
    return body.items.map((raw) => ({
      toolId: raw.tool_id,
      slug: raw.slug,
      name: raw.name,
      ...(raw.description !== undefined && { description: raw.description }),
      toolType: raw.tool_type,
      riskLevel: raw.risk_level,
      requiresApproval: raw.requires_approval,
      rateLimitPerMinute: raw.rate_limit_per_minute,
    }));
  }

  async listBindings(accessToken: string, projectId: string): Promise<Binding[]> {
    const body = await this.json<{ items: RawBinding[] }>(`${this.baseUrl}/v1/bindings`, {
      accessToken,
      projectId,
    });
    return body.items.map(toBinding);
  }

  async bind(
    accessToken: string,
    projectId: string,
    toolId: string,
    input: { enabled: boolean; rateLimitPerMinute?: number; requireApproval?: boolean },
  ): Promise<Binding> {
    const raw = await this.json<RawBinding>(
      `${this.baseUrl}/v1/bindings/${encodeURIComponent(toolId)}`,
      {
        method: 'PUT',
        accessToken,
        projectId,
        body: {
          enabled: input.enabled,
          ...(input.rateLimitPerMinute !== undefined && {
            rate_limit_per_minute: input.rateLimitPerMinute,
          }),
          ...(input.requireApproval !== undefined && { require_approval: input.requireApproval }),
        },
      },
    );
    return toBinding(raw);
  }

  async unbind(accessToken: string, projectId: string, toolId: string): Promise<void> {
    await this.json<undefined>(`${this.baseUrl}/v1/bindings/${encodeURIComponent(toolId)}`, {
      method: 'DELETE',
      accessToken,
      projectId,
    });
  }

  private async json<T>(
    url: string,
    options: { method?: string; accessToken?: string; projectId?: string; body?: unknown } = {},
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

interface RawBinding {
  tool_id: string;
  enabled: boolean;
  rate_limit_per_minute: number | null;
  require_approval: boolean | null;
}

interface RawTool {
  tool_id: string;
  slug: string;
  name: string;
  description?: string;
  tool_type: EffectiveTool['toolType'];
  risk_level: EffectiveTool['riskLevel'];
  requires_approval: boolean;
  rate_limit_per_minute: number | null;
}

interface RawConnection {
  id: string;
  slug: string;
  name: string;
  description?: string;
  kind: ConnectionSummary['kind'];
  header: string;
  secret_ref: string;
  resolved: boolean;
}

function toConnection(raw: RawConnection): ConnectionSummary {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    ...(raw.description !== undefined && { description: raw.description }),
    kind: raw.kind,
    header: raw.header,
    secretRef: raw.secret_ref,
    resolved: raw.resolved,
  };
}

function toBinding(raw: RawBinding): Binding {
  return {
    toolId: raw.tool_id,
    enabled: raw.enabled,
    rateLimitPerMinute: raw.rate_limit_per_minute,
    requireApproval: raw.require_approval,
  };
}

async function problemFrom(response: Response): Promise<PlatformError> {
  try {
    return new PlatformError((await response.json()) as ProblemDetails);
  } catch {
    return new PlatformError({
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: 'internal_error',
    });
  }
}

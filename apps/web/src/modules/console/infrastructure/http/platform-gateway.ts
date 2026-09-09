import { PlatformError, type ProblemDetails } from '../../domain/errors';
import type {
  BudgetSnapshot,
  ChatRequest,
  CompletionRecord,
  ChatStreamEvent,
  ModelAliasSummary,
  PlatformGateway,
  PolicySnapshot,
  ProjectSummary,
  RoutingReport,
} from '../../application/ports';
import type { Principal } from '../../domain/session';
import { parseSse } from '../../domain/sse';

export interface PlatformEndpoints {
  identity: string;
  governance: string;
  router: string;
}

/**
 * The platform reached over HTTP.
 *
 * This adapter is the only place that knows identity, governance and the router
 * are three services on three URLs. It runs SERVER-SIDE only: it takes an access
 * token as an argument, and a token that reaches the browser is a token an XSS
 * can read.
 */
export class HttpPlatformGateway implements PlatformGateway {
  constructor(
    private readonly endpoints: PlatformEndpoints,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async signIn(
    username: string,
    password: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const body = await this.json<{ access_token: string; expires_in: number }>(
      `${this.endpoints.identity}/v1/auth/token`,
      { method: 'POST', body: { grant_type: 'password', username, password } },
    );
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  }

  async currentPrincipal(accessToken: string): Promise<Principal> {
    const body = await this.json<{
      id: string;
      type: string;
      email?: string;
      display_name?: string;
      global_roles?: string[];
      memberships?: { project_id: string; roles?: string[] }[];
    }>(`${this.endpoints.identity}/v1/me`, { accessToken });

    return {
      id: body.id,
      type: body.type,
      ...(body.email !== undefined && { email: body.email }),
      ...(body.display_name !== undefined && { displayName: body.display_name }),
      globalRoles: body.global_roles ?? [],
      memberships: (body.memberships ?? []).map((membership) => ({
        projectId: membership.project_id,
        roles: membership.roles ?? [],
      })),
    };
  }

  async listProjects(accessToken: string): Promise<ProjectSummary[]> {
    const body = await this.json<{ items: RawProject[] }>(
      `${this.endpoints.governance}/v1/projects`,
      { accessToken },
    );
    return body.items.map(toProject);
  }

  async getProject(accessToken: string, projectId: string): Promise<ProjectSummary> {
    return toProject(
      await this.json<RawProject>(
        `${this.endpoints.governance}/v1/projects/${encodeURIComponent(projectId)}`,
        { accessToken },
      ),
    );
  }

  async createProject(
    accessToken: string,
    input: {
      slug: string;
      name: string;
      description?: string;
      dataClassification: string;
      legalBasis: string;
      purpose: string;
    },
  ): Promise<ProjectSummary> {
    return toProject(
      await this.json<RawProject>(`${this.endpoints.governance}/v1/projects`, {
        method: 'POST',
        accessToken,
        body: {
          slug: input.slug,
          name: input.name,
          ...(input.description !== undefined && { description: input.description }),
          data_classification: input.dataClassification,
          legal_basis: input.legalBasis,
          purpose: input.purpose,
        },
      }),
    );
  }

  async getBudget(accessToken: string, projectId: string): Promise<BudgetSnapshot> {
    return toBudget(
      await this.json<RawBudget>(
        `${this.endpoints.governance}/v1/projects/${encodeURIComponent(projectId)}/budget`,
        { accessToken },
      ),
    );
  }

  async setBudget(
    accessToken: string,
    projectId: string,
    input: { currency: string; micros: string; period: 'daily' | 'monthly'; blockAtLimit: boolean },
  ): Promise<BudgetSnapshot> {
    return toBudget(
      await this.json<RawBudget>(
        `${this.endpoints.governance}/v1/projects/${encodeURIComponent(projectId)}/budget`,
        {
          method: 'PUT',
          accessToken,
          body: {
            // The platform reads micros as an integer. Sending a JSON number
            // would cap the value at 2^53 and silently lose precision on a large
            // budget, so it travels as a string.
            limit: { currency: input.currency, micros: input.micros },
            period: input.period,
            block_at_limit: input.blockAtLimit,
          },
        },
      ),
    );
  }

  async getPolicy(accessToken: string, projectId: string): Promise<PolicySnapshot> {
    const body = await this.json<{
      project_id: string;
      data_classification: string;
      allowed_data_zones: string[];
      max_concurrent_requests?: number;
      content_capture?: boolean;
      version: number;
    }>(`${this.endpoints.governance}/v1/projects/${encodeURIComponent(projectId)}/policy`, {
      accessToken,
    });

    return {
      projectId: body.project_id,
      dataClassification: body.data_classification,
      allowedDataZones: body.allowed_data_zones,
      maxConcurrentRequests: body.max_concurrent_requests ?? 20,
      contentCapture: body.content_capture ?? false,
      version: body.version,
    };
  }

  async listModels(accessToken: string, projectId: string): Promise<ModelAliasSummary[]> {
    const body = await this.json<{
      data: {
        id: string;
        description?: string;
        capabilities?: string[];
        max_output_tokens?: number;
        data_zones?: string[];
      }[];
    }>(`${this.endpoints.router}/v1/models`, { accessToken, projectId });

    return body.data.map((alias) => ({
      id: alias.id,
      ...(alias.description !== undefined && { description: alias.description }),
      capabilities: alias.capabilities ?? [],
      ...(alias.max_output_tokens !== undefined && { maxOutputTokens: alias.max_output_tokens }),
      dataZones: alias.data_zones ?? [],
    }));
  }

  async readCompletionRecord(
    accessToken: string,
    projectId: string,
    requestId: string,
  ): Promise<CompletionRecord> {
    const body = await this.json<{
      request_id: string;
      alias: string;
      status: string;
      prompt_tokens?: number;
      completion_tokens?: number;
      cost_micros?: number;
      currency?: string;
      duration_ms?: number;
      error_code: string | null;
      guardrails_unverified?: boolean;
      content_captured: boolean;
      prompt: string | null;
      completion: string | null;
      occurred_at: string;
      expires_at: string;
    }>(`${this.endpoints.router}/v1/completions/${encodeURIComponent(requestId)}`, {
      accessToken,
      projectId,
    });

    return {
      requestId: body.request_id,
      alias: body.alias,
      status: body.status,
      promptTokens: body.prompt_tokens ?? 0,
      completionTokens: body.completion_tokens ?? 0,
      costMicros: body.cost_micros ?? 0,
      currency: body.currency ?? '',
      durationMs: body.duration_ms ?? 0,
      errorCode: body.error_code,
      guardrailsUnverified: body.guardrails_unverified ?? false,
      contentCaptured: body.content_captured,
      prompt: body.prompt,
      completion: body.completion,
      occurredAt: body.occurred_at,
      expiresAt: body.expires_at,
    };
  }

  async *streamChat(accessToken: string, request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    // No timeout on the stream: a long answer is not a hung request, and an
    // abort here would cut a completion the project has already paid for.
    const response = await this.fetchImpl(`${this.endpoints.router}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        'X-Project-Id': request.projectId,
      },
      body: JSON.stringify({
        model: request.alias,
        messages: request.messages,
        stream: true,
        ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      }),
    });

    if (!response.ok || response.body === null) {
      // The failure arrived before the first event, so it still carries a status
      // and Problem Details. Once bytes are flowing, an error can only come
      // through as an `error` event inside the stream.
      throw await problemFrom(response);
    }

    for await (const event of parseSse(response.body)) {
      const mapped = toStreamEvent(event.name, event.data);
      if (mapped !== null) yield mapped;
    }
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

interface RawProject {
  id: string;
  slug: string;
  name: string;
  description?: string;
  data_classification: string;
  legal_basis?: string;
  purpose?: string;
  created_at: string;
}

interface RawBudget {
  project_id: string;
  limit: { currency: string; micros: number | string };
  spent: { currency: string; micros: number | string };
  reserved?: { currency: string; micros: number | string };
  period: 'daily' | 'monthly';
  period_start: string;
  period_end: string;
  block_at_limit?: boolean;
}

function toProject(raw: RawProject): ProjectSummary {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    ...(raw.description !== undefined && { description: raw.description }),
    dataClassification: raw.data_classification,
    ...(raw.legal_basis !== undefined && { legalBasis: raw.legal_basis }),
    ...(raw.purpose !== undefined && { purpose: raw.purpose }),
    createdAt: raw.created_at,
  };
}

function toBudget(raw: RawBudget): BudgetSnapshot {
  return {
    projectId: raw.project_id,
    limit: { currency: raw.limit.currency, micros: String(raw.limit.micros) },
    spent: { currency: raw.spent.currency, micros: String(raw.spent.micros) },
    ...(raw.reserved !== undefined && {
      reserved: { currency: raw.reserved.currency, micros: String(raw.reserved.micros) },
    }),
    period: raw.period,
    periodStart: raw.period_start,
    periodEnd: raw.period_end,
    blockAtLimit: raw.block_at_limit ?? true,
  };
}

/**
 * Maps one SSE event onto the port's vocabulary.
 *
 * An unknown event name yields nothing rather than throwing: the platform may
 * add an event type, and a console that crashed on it would break on a
 * backwards-compatible change.
 */
function toStreamEvent(name: string, data: unknown): ChatStreamEvent | null {
  if (name === 'message.delta') {
    const payload = data as { delta?: { content?: string } };
    return { kind: 'delta', content: payload.delta?.content ?? '' };
  }

  if (name === 'run.finished') {
    const payload = data as {
      choices?: { message?: { content?: string } }[];
      aia?: Record<string, unknown>;
    };
    return {
      kind: 'finished',
      content: payload.choices?.[0]?.message?.content ?? '',
      routing: toRouting(payload.aia ?? {}),
    };
  }

  if (name === 'error') {
    const payload = data as { code?: string; message?: string };
    return {
      kind: 'error',
      code: payload.code ?? 'internal_error',
      message: payload.message ?? 'The stream failed.',
    };
  }

  return null;
}

function toRouting(aia: Record<string, unknown>): RoutingReport {
  const cost = aia['cost'] as { currency?: string; micros?: number | string } | undefined;
  return {
    ...(typeof aia['deployment_id'] === 'string' && { deploymentId: aia['deployment_id'] }),
    ...(typeof aia['provider'] === 'string' && { provider: aia['provider'] }),
    ...(typeof aia['provider_model'] === 'string' && { providerModel: aia['provider_model'] }),
    ...(typeof aia['data_zone'] === 'string' && { dataZone: aia['data_zone'] }),
    ...(cost?.currency !== undefined &&
      cost.micros !== undefined && {
        cost: { currency: cost.currency, micros: String(cost.micros) },
      }),
    ...(typeof aia['cache_hit'] === 'boolean' && { cacheHit: aia['cache_hit'] }),
    ...(typeof aia['policy_stale'] === 'boolean' && { policyStale: aia['policy_stale'] }),
    ...(typeof aia['budget_unverified'] === 'boolean' && {
      budgetUnverified: aia['budget_unverified'],
    }),
    ...(typeof aia['attempts'] === 'number' && { attempts: aia['attempts'] }),
  };
}

/**
 * Turns a failed response into a PlatformError.
 *
 * A body that is not Problem Details still becomes one, with a generic detail:
 * the console must not render whatever HTML a misconfigured proxy returned.
 */
async function problemFrom(response: Response): Promise<PlatformError> {
  const fallback: ProblemDetails = {
    type: 'https://aia.dev/errors/internal_error',
    title: 'Error',
    status: response.status,
    code: 'internal_error',
    detail: `The platform answered ${response.status.toString()}.`,
  };

  try {
    const body = (await response.json()) as Partial<ProblemDetails>;
    if (typeof body.code !== 'string') return new PlatformError(fallback);
    return new PlatformError({
      ...fallback,
      ...body,
      code: body.code,
      status: body.status ?? response.status,
    });
  } catch {
    return new PlatformError(fallback);
  }
}

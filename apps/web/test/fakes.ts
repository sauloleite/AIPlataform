import { PlatformError } from '../src/modules/console/domain/errors';
import type {
  BudgetSnapshot,
  ChatRequest,
  CompletionRecord,
  ChatStreamEvent,
  ModelAliasSummary,
  PlatformGateway,
  PolicySnapshot,
  ProjectSummary,
  SessionStore,
} from '../src/modules/console/application/ports';
import type { Principal, Session } from '../src/modules/console/domain/session';

/**
 * A fake platform, not a mock.
 *
 * It honours the port and lets a test say what the platform holds, so the
 * assertions are about behaviour rather than about which method was called in
 * which order.
 */
export class FakePlatform implements PlatformGateway {
  projects: ProjectSummary[] = [];
  budgets = new Map<string, BudgetSnapshot>();
  policies = new Map<string, PolicySnapshot>();
  aliases = new Map<string, ModelAliasSummary[]>();
  streamEvents: ChatStreamEvent[] = [];
  records = new Map<string, CompletionRecord>();

  readonly calls: string[] = [];
  /** Endpoints set to fail, keyed the same way as `calls`. */
  readonly failing = new Set<string>();

  signIn(): Promise<{ accessToken: string; expiresIn: number }> {
    this.calls.push('signIn');
    if (this.failing.has('signIn')) throw problem('unauthenticated', 401);
    return Promise.resolve({ accessToken: 'token-1', expiresIn: 3600 });
  }

  currentPrincipal(): Promise<Principal> {
    this.calls.push('currentPrincipal');
    return Promise.resolve({
      id: 'user-1',
      type: 'user',
      email: 'admin@aia.local',
      globalRoles: ['platform_admin'],
      memberships: [],
    });
  }

  listProjects(): Promise<ProjectSummary[]> {
    this.calls.push('listProjects');
    return Promise.resolve([...this.projects]);
  }

  getProject(_token: string, projectId: string): Promise<ProjectSummary> {
    this.calls.push(`getProject:${projectId}`);
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw problem('project_not_found', 404);
    return Promise.resolve(project);
  }

  createProject(
    _token: string,
    input: {
      slug: string;
      name: string;
      description?: string;
      dataClassification: string;
      legalBasis: string;
      purpose: string;
    },
  ): Promise<ProjectSummary> {
    this.calls.push(`createProject:${input.slug}`);
    const project: ProjectSummary = {
      id: `proj-${(this.projects.length + 1).toString()}`,
      slug: input.slug,
      name: input.name,
      ...(input.description !== undefined && { description: input.description }),
      dataClassification: input.dataClassification,
      legalBasis: input.legalBasis,
      purpose: input.purpose,
      createdAt: '2026-08-26T00:00:00Z',
    };
    this.projects.push(project);
    return Promise.resolve(project);
  }

  getBudget(_token: string, projectId: string): Promise<BudgetSnapshot> {
    this.calls.push(`getBudget:${projectId}`);
    if (this.failing.has(`getBudget:${projectId}`)) throw problem('upstream_timeout', 504);
    const budget = this.budgets.get(projectId);
    if (budget === undefined) throw problem('not_found', 404);
    return Promise.resolve(budget);
  }

  setBudget(
    _token: string,
    projectId: string,
    input: { currency: string; micros: string; period: 'daily' | 'monthly'; blockAtLimit: boolean },
  ): Promise<BudgetSnapshot> {
    this.calls.push(`setBudget:${projectId}:${input.micros}`);
    const budget: BudgetSnapshot = {
      projectId,
      limit: { currency: input.currency, micros: input.micros },
      spent: { currency: input.currency, micros: '0' },
      period: input.period,
      periodStart: '2026-08-01T00:00:00Z',
      periodEnd: '2026-08-31T23:59:59Z',
      blockAtLimit: input.blockAtLimit,
    };
    this.budgets.set(projectId, budget);
    return Promise.resolve(budget);
  }

  getPolicy(_token: string, projectId: string): Promise<PolicySnapshot> {
    this.calls.push(`getPolicy:${projectId}`);
    if (this.failing.has(`getPolicy:${projectId}`)) throw problem('upstream_timeout', 504);
    const policy = this.policies.get(projectId);
    if (policy === undefined) throw problem('not_found', 404);
    return Promise.resolve(policy);
  }

  listModels(_token: string, projectId: string): Promise<ModelAliasSummary[]> {
    this.calls.push(`listModels:${projectId}`);
    return Promise.resolve(this.aliases.get(projectId) ?? []);
  }

  readCompletionRecord(
    _token: string,
    projectId: string,
    requestId: string,
  ): Promise<CompletionRecord> {
    this.calls.push(`readCompletionRecord:${projectId}:${requestId}`);
    if (this.failing.has('readCompletionRecord')) throw problem('forbidden', 403);

    const record = this.records.get(requestId);
    if (record === undefined) throw problem('not_found', 404);
    return Promise.resolve(record);
  }

  async *streamChat(_token: string, request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.calls.push(`streamChat:${request.alias}:${request.messages.length.toString()}`);
    for (const event of this.streamEvents) {
      yield await Promise.resolve(event);
    }
  }
}

export class InMemorySessionStore implements SessionStore {
  private session: Session | null = null;
  private token: string | null = null;
  cleared = 0;

  read(): Promise<Session | null> {
    return Promise.resolve(this.session);
  }

  readToken(): Promise<string | null> {
    return Promise.resolve(this.token);
  }

  write(session: Session, accessToken: string): Promise<void> {
    this.session = session;
    this.token = accessToken;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.cleared += 1;
    this.session = null;
    this.token = null;
    return Promise.resolve();
  }
}

export function frozenClock(nowSeconds: number): { nowSeconds: () => number } {
  return { nowSeconds: () => nowSeconds };
}

export function aProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'proj-1',
    slug: 'sample',
    name: 'Sample project',
    dataClassification: 'internal',
    createdAt: '2026-08-26T00:00:00Z',
    ...overrides,
  };
}

export function aBudget(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    projectId: 'proj-1',
    limit: { currency: 'BRL', micros: '50000000' },
    spent: { currency: 'BRL', micros: '10000000' },
    period: 'monthly',
    periodStart: '2026-08-01T00:00:00Z',
    periodEnd: '2026-08-31T23:59:59Z',
    blockAtLimit: true,
    ...overrides,
  };
}

function problem(code: string, status: number): PlatformError {
  return new PlatformError({
    type: `https://aia.dev/errors/${code}`,
    title: code,
    status,
    code,
  });
}

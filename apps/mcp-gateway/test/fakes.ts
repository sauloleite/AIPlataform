/**
 * In-memory stand-ins for the gateway's ports.
 *
 * Fakes, not mocks: each one behaves like the real store it replaces, so a
 * test asserts on what ended up recorded or refused -- never on which method
 * was called in which order.
 */
import type { CloudEvent } from '@aia/messaging';
import type { Principal } from '@aia/auth';

import type {
  ApprovalStore,
  AuditRepository,
  BindingRepository,
  ClassificationReader,
  Clock,
  ConnectionRepository,
  IdGenerator,
  InvocationRecord,
  PendingApproval,
  RateLimiter,
  SecretResolver,
  ToolCatalog,
  ToolExecutor,
  ToolInvocation,
  ToolOutcome,
} from '../src/modules/tools/application/ports.js';
import type { Connection } from '../src/modules/tools/domain/entities/connection.js';
import type { ToolBinding } from '../src/modules/tools/domain/entities/tool-binding.js';
import type { ToolDefinition } from '../src/modules/tools/domain/value-objects/index.js';

export const PROJECT = 'p1';
export const TOKEN = 'caller-token';
export const NOW = new Date('2026-09-15T12:00:00Z');

export function principal(roles: string[] = ['project_editor'], projectId = PROJECT): Principal {
  return {
    id: 'user-ana',
    type: 'user',
    globalRoles: [],
    memberships: [{ projectId, roles }],
    scopes: [],
    issuer: 'http://identity:3001',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
}

export class FakeToolCatalog implements ToolCatalog {
  readonly tools: ToolDefinition[] = [];
  lookups = 0;

  async find(input: { toolId: string }): Promise<ToolDefinition | null> {
    this.lookups += 1;
    return this.tools.find((tool) => tool.toolId === input.toolId) ?? null;
  }

  async list(): Promise<ToolDefinition[]> {
    return [...this.tools];
  }
}

export class FakeBindingRepository implements BindingRepository {
  private readonly bindings = new Map<string, ToolBinding>();

  async find(projectId: string, toolId: string): Promise<ToolBinding | null> {
    return this.bindings.get(`${projectId}:${toolId}`) ?? null;
  }

  async list(projectId: string): Promise<ToolBinding[]> {
    return [...this.bindings.values()].filter((binding) => binding.projectId === projectId);
  }

  async save(binding: ToolBinding): Promise<void> {
    this.bindings.set(`${binding.projectId}:${binding.toolId}`, binding);
  }

  async remove(projectId: string, toolId: string): Promise<void> {
    this.bindings.delete(`${projectId}:${toolId}`);
  }
}

/** Counts what was consumed; refuses once the limit for a key is reached. */
export class FakeRateLimiter implements RateLimiter {
  readonly consumed = new Map<string, number>();

  async consume(input: {
    key: string;
    limitPerMinute: number;
  }): Promise<{ retryAfterSeconds: number } | null> {
    const used = this.consumed.get(input.key) ?? 0;
    if (used >= input.limitPerMinute) return { retryAfterSeconds: 60 };
    this.consumed.set(input.key, used + 1);
    return null;
  }
}

export class FakeApprovalStore implements ApprovalStore {
  readonly open_: PendingApproval[] = [];

  async open(approval: PendingApproval): Promise<void> {
    this.open_.push(approval);
  }

  async take(input: { projectId: string; approvalId: string }): Promise<PendingApproval | null> {
    const index = this.open_.findIndex(
      (approval) => approval.id === input.approvalId && approval.projectId === input.projectId,
    );
    if (index === -1) return null;
    return this.open_.splice(index, 1)[0] ?? null;
  }
}

export class FakeAuditRepository implements AuditRepository {
  readonly records: InvocationRecord[] = [];
  readonly events: CloudEvent[] = [];

  async record(entry: InvocationRecord, events: readonly CloudEvent[] = []): Promise<void> {
    this.records.push(entry);
    this.events.push(...events);
  }
}

export class FakeConnectionRepository implements ConnectionRepository {
  async find(): Promise<Connection | null> {
    return null;
  }
  async findBySlug(): Promise<Connection | null> {
    return null;
  }
  async list(): Promise<Connection[]> {
    return [];
  }
  async save(): Promise<void> {
    // Nothing to keep: no test here reads a connection back.
  }
  async remove(): Promise<boolean> {
    return false;
  }
}

export class FakeSecretResolver implements SecretResolver {
  constructor(private readonly secrets: Record<string, string> = {}) {}

  async resolve(secretRef: string): Promise<string | null> {
    return this.secrets[secretRef] ?? null;
  }
}

/** Governance, as far as a classification goes. `null` is governance being down. */
export class FakeClassificationReader implements ClassificationReader {
  reads = 0;

  constructor(public classification: string | null = 'internal') {}

  async classificationOf(): Promise<string> {
    this.reads += 1;
    if (this.classification === null) throw new Error('governance is unreachable');
    return this.classification;
  }
}

/** Runs whatever it supports and remembers what it was given. */
export class FakeExecutor implements ToolExecutor {
  readonly invocations: ToolInvocation[] = [];

  constructor(
    private readonly accepts: (tool: ToolDefinition) => boolean,
    private readonly outcome: (invocation: ToolInvocation) => Promise<ToolOutcome> = async () => ({
      result: 'ran',
      durationMs: 1,
    }),
    public unavailable: string | null = null,
  ) {}

  supports(tool: ToolDefinition): boolean {
    return this.accepts(tool);
  }

  async unavailableReason(): Promise<string | null> {
    return this.unavailable;
  }

  async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    this.invocations.push(invocation);
    return this.outcome(invocation);
  }
}

export const fixedClock: Clock = { now: () => NOW };

export class SequentialIds implements IdGenerator {
  private next_ = 0;
  next(): string {
    this.next_ += 1;
    return `id-${this.next_.toString()}`;
  }
}

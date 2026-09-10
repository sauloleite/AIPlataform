/**
 * Fixtures shared by the invocation specs.
 *
 * Extracted when the telemetry spec needed the same harness: a second copy of a
 * fake that has to honour the same contract is a second place for it to drift
 * from the port it stands for.
 */
import { ROLES, type Principal } from '@aia/auth';

import { InvokeTool } from '../src/modules/tools/application/use-cases/invoke-tool.js';
import { ToolBinding } from '../src/modules/tools/domain/entities/tool-binding.js';
import { AjvSchemaValidator } from '../src/modules/tools/infrastructure/schema/ajv-schema-validator.js';
import type {
  ApprovalStore,
  AuditRepository,
  BindingRepository,
  ConnectionRepository,
  InvocationRecord,
  PendingApproval,
  RateLimiter,
  SecretResolver,
  ToolCatalog,
  ToolExecutor,
  ToolInvocation,
  ToolOutcome,
} from '../src/modules/tools/application/ports.js';
import type { InvokeToolCommand } from '../src/modules/tools/application/dto.js';
import type { ToolDefinition } from '../src/modules/tools/domain/value-objects/index.js';

export const NOW = new Date('2026-09-08T12:00:00Z');
export const PROJECT = 'p1';

/** The schema most of these tests validate against: two fields, one required. */
export const SEARCH_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string' },
    top_k: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
};

export function aPrincipal(roles: string[] = [ROLES.PROJECT_EDITOR]): Principal {
  return {
    id: 'user-ana',
    type: 'user',
    scopes: [],
    globalRoles: [],
    memberships: [{ projectId: PROJECT, roles }],
  } as unknown as Principal;
}

export function aTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    toolId: 't1',
    slug: 'file_search',
    name: 'File search',
    toolType: 'builtin',
    riskLevel: 'low',
    builtinId: 'file_search',
    parameters: SEARCH_SCHEMA,
    ...overrides,
  };
}

export class RecordingExecutor implements ToolExecutor {
  readonly invocations: ToolInvocation[] = [];

  supports(): boolean {
    return true;
  }

  execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    this.invocations.push(invocation);
    return Promise.resolve({ result: { ok: true }, durationMs: 3 });
  }
}

export class CountingRateLimiter implements RateLimiter {
  consumed = 0;
  private full = false;

  goFull(): void {
    this.full = true;
  }

  consume(): Promise<{ retryAfterSeconds: number } | null> {
    this.consumed += 1;
    return Promise.resolve(this.full ? { retryAfterSeconds: 30 } : null);
  }
}

export class RecordingApprovals implements ApprovalStore {
  readonly opened: PendingApproval[] = [];

  open(approval: PendingApproval): Promise<void> {
    this.opened.push(approval);
    return Promise.resolve();
  }

  take(): Promise<PendingApproval | null> {
    return Promise.resolve(null);
  }
}

export class RecordingAudit implements AuditRepository {
  readonly entries: InvocationRecord[] = [];

  record(entry: InvocationRecord): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

export interface Harness {
  useCase: InvokeTool;
  executor: RecordingExecutor;
  limiter: CountingRateLimiter;
  approvals: RecordingApprovals;
  audit: RecordingAudit;
}

export function build(tool: ToolDefinition = aTool()): Harness {
  const executor = new RecordingExecutor();
  const limiter = new CountingRateLimiter();
  const approvals = new RecordingApprovals();
  const audit = new RecordingAudit();

  const catalog: ToolCatalog = {
    find: () => Promise.resolve(tool),
    list: () => Promise.resolve([tool]),
  };
  const bindings: Pick<BindingRepository, 'find'> = {
    find: () => Promise.resolve(ToolBinding.create({ projectId: PROJECT, toolId: 't1', now: NOW })),
  };
  const connections: Pick<ConnectionRepository, 'find'> = { find: () => Promise.resolve(null) };
  const secrets: SecretResolver = { resolve: () => Promise.resolve(null) };

  const useCase = new InvokeTool(
    catalog,
    bindings as BindingRepository,
    limiter,
    approvals,
    [executor],
    // The REAL validator, not a fake: a fake that always agreed would make
    // every test below pass while the gateway forwarded anything.
    new AjvSchemaValidator(),
    connections as ConnectionRepository,
    secrets,
    audit,
    { now: () => NOW },
    { next: () => 'id-1' },
  );

  return { useCase, executor, limiter, approvals, audit };
}

export function aCommand(args: Record<string, unknown>): InvokeToolCommand {
  return {
    projectId: PROJECT,
    toolId: 't1',
    principalId: 'user-ana',
    accessToken: 'token',
    arguments: args,
  };
}

/**
 * OWASP LLM05, improper output handling.
 *
 * The registry validates a tool's schema when it is published. Nothing checked
 * the ARGUMENTS at invoke time, so whatever the model produced was forwarded.
 * The published design patterns against prompt injection stop untrusted input
 * from selecting an action; none of them governs what the selected action
 * carries, and this is that gap.
 */

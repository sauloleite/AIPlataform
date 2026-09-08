import { describe, expect, it } from 'vitest';
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
import type { RiskLevel, ToolDefinition } from '../src/modules/tools/domain/value-objects/index.js';

const NOW = new Date('2026-09-08T12:00:00Z');
const PROJECT = 'p1';

/** The schema most of these tests validate against: two fields, one required. */
const SEARCH_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string' },
    top_k: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
};

function aPrincipal(roles: string[] = [ROLES.PROJECT_EDITOR]): Principal {
  return {
    id: 'user-ana',
    type: 'user',
    scopes: [],
    globalRoles: [],
    memberships: [{ projectId: PROJECT, roles }],
  } as unknown as Principal;
}

function aTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
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

class RecordingExecutor implements ToolExecutor {
  readonly invocations: ToolInvocation[] = [];

  supports(): boolean {
    return true;
  }

  execute(invocation: ToolInvocation): Promise<ToolOutcome> {
    this.invocations.push(invocation);
    return Promise.resolve({ result: { ok: true }, durationMs: 3 });
  }
}

class CountingRateLimiter implements RateLimiter {
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

class RecordingApprovals implements ApprovalStore {
  readonly opened: PendingApproval[] = [];

  open(approval: PendingApproval): Promise<void> {
    this.opened.push(approval);
    return Promise.resolve();
  }

  take(): Promise<PendingApproval | null> {
    return Promise.resolve(null);
  }
}

class RecordingAudit implements AuditRepository {
  readonly entries: InvocationRecord[] = [];

  record(entry: InvocationRecord): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

function build(tool: ToolDefinition = aTool()) {
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

function aCommand(args: Record<string, unknown>) {
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
describe('tool arguments against the declared schema', () => {
  it('refuses a missing required field', async () => {
    const { useCase, executor } = build();

    await expect(useCase.execute(aCommand({ top_k: 5 }), aPrincipal())).rejects.toMatchObject({
      code: 'tool_arguments_invalid',
      status: 400,
    });
    expect(executor.invocations).toHaveLength(0);
  });

  it('refuses a field of the wrong type', async () => {
    const { useCase, executor } = build();

    await expect(
      useCase.execute(aCommand({ query: 'leave', top_k: 'many' }), aPrincipal()),
    ).rejects.toMatchObject({ code: 'tool_arguments_invalid' });
    expect(executor.invocations).toHaveLength(0);
  });

  it('refuses a field the tool never declared', async () => {
    const { useCase, executor } = build();

    // The interesting case: an injected instruction that rides along as an
    // extra argument the executor would otherwise forward untouched.
    await expect(
      useCase.execute(
        aCommand({ query: 'leave', callback_url: 'https://attacker.example' }),
        aPrincipal(),
      ),
    ).rejects.toMatchObject({ code: 'tool_arguments_invalid' });
    expect(executor.invocations).toHaveLength(0);
  });

  it('refuses a value outside the declared bounds', async () => {
    const { useCase } = build();

    await expect(
      useCase.execute(aCommand({ query: 'leave', top_k: 5000 }), aPrincipal()),
    ).rejects.toMatchObject({ code: 'tool_arguments_invalid' });
  });

  it('reports every problem at once, not the first', async () => {
    const { useCase } = build();

    let reasons: string[] = [];
    try {
      await useCase.execute(aCommand({ top_k: 'many', extra: 1 }), aPrincipal());
    } catch (error) {
      reasons = (error as { details: { reasons: string[] } }).details.reasons;
    }

    // A model correcting itself one field per turn burns a turn per field.
    expect(reasons.length).toBeGreaterThan(1);
  });

  it('refuses when the tool itself declares a schema that is not valid', async () => {
    const { useCase, executor } = build(aTool({ parameters: { type: 'not-a-json-schema-type' } }));

    // A tool published with a broken schema must not become the one tool
    // nobody checks -- which is exactly the tool worth attacking.
    await expect(useCase.execute(aCommand({ anything: true }), aPrincipal())).rejects.toMatchObject(
      {
        code: 'tool_arguments_invalid',
      },
    );
    expect(executor.invocations).toHaveLength(0);
  });

  it('lets valid arguments through', async () => {
    const { useCase, executor } = build();

    await useCase.execute(aCommand({ query: 'leave', top_k: 5 }), aPrincipal());

    expect(executor.invocations[0]?.arguments).toMatchObject({ query: 'leave', top_k: 5 });
  });

  it('does not validate a tool that declares no parameters', async () => {
    const { useCase, executor } = build(aTool({ parameters: undefined }));

    await useCase.execute(aCommand({ anything: 'at all' }), aPrincipal());

    // `parameters` is optional in the registry, and reading "undeclared" as
    // "nothing allowed" would break every tool that takes free-form input.
    expect(executor.invocations).toHaveLength(1);
  });
});

/**
 * Where the check sits is as much of the decision as the check itself.
 */
describe('the order the guards run in', () => {
  it('refuses before spending the project rate allowance', async () => {
    const { useCase, limiter } = build();

    await useCase.execute(aCommand({ top_k: 5 }), aPrincipal()).catch(() => undefined);

    // Same reasoning the rate limiter already carries for the authorisation
    // decision: a refused call must not eat somebody else's allowance.
    expect(limiter.consumed).toBe(0);
  });

  it('refuses before asking a human to approve a high-risk call', async () => {
    const { useCase, approvals } = build(aTool({ riskLevel: 'high' as RiskLevel }));

    await useCase
      .execute(aCommand({ query: 1 }), aPrincipal([ROLES.PROJECT_OWNER]))
      .catch(() => undefined);

    // Approval is the scarcest resource this control has: a person. Asking one
    // to authorise arguments that cannot run spends it for nothing.
    expect(approvals.opened).toHaveLength(0);
  });

  it('audits the refusal with its error code', async () => {
    const { useCase, audit } = build();

    await useCase.execute(aCommand({ top_k: 5 }), aPrincipal()).catch(() => undefined);

    expect(audit.entries[0]).toMatchObject({
      status: 'denied',
      errorCode: 'tool_arguments_invalid',
      principalId: 'user-ana',
    });
  });
});

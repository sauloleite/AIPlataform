import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Span } from '@opentelemetry/api';
import { EVENT_TYPES, newEvent } from '@aia/messaging';
import {
  AIA_ATTR,
  GEN_AI_ATTR,
  GEN_AI_SPAN,
  currentTraceId,
  getTracer,
  recordSpanError,
} from '@aia/telemetry';
import type { Principal } from '@aia/auth';

import {
  ApprovalRequiredError,
  ToolExecutionFailedError,
  ToolNotAllowedError,
  ToolArgumentsInvalidError,
  ToolNotFoundError,
  ToolRateLimitedError,
} from '../../domain/errors/index.js';
import { decideInvocation } from '../../domain/services/invocation-policy.js';
import type { ToolDefinition } from '../../domain/value-objects/index.js';
import type { InvocationResultView, InvokeToolCommand } from '../dto.js';
import {
  APPROVAL_STORE,
  CONNECTION_REPOSITORY,
  SECRET_RESOLVER,
  AUDIT_REPOSITORY,
  BINDING_REPOSITORY,
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  TOOL_CATALOG,
  SCHEMA_VALIDATOR,
  TOOL_EXECUTORS,
  type ApprovalStore,
  type AuditRepository,
  type BindingRepository,
  type Clock,
  type IdGenerator,
  type ConnectionRepository,
  type RateLimiter,
  type ResolvedCredential,
  type SecretResolver,
  type ToolCatalog,
  type SchemaValidator,
  type ToolExecutor,
} from '../ports.js';

const SOURCE = 'aia-mcp-gateway';

/** An approval that outlives the intent behind it is a blank cheque. */
const APPROVAL_TTL_SECONDS = 900;

/**
 * Runs a tool, governed.
 *
 * The order is deliberate: resolve, decide, rate-limit, approve, execute,
 * audit. Deciding before consuming the rate means a refused call does not eat
 * somebody's budget, and auditing last means the record carries the outcome.
 */
@Injectable()
export class InvokeTool {
  constructor(
    @Inject(TOOL_CATALOG) private readonly catalog: ToolCatalog,
    @Inject(BINDING_REPOSITORY) private readonly bindings: BindingRepository,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(APPROVAL_STORE) private readonly approvals: ApprovalStore,
    @Inject(TOOL_EXECUTORS) private readonly executors: readonly ToolExecutor[],
    @Inject(SCHEMA_VALIDATOR) private readonly schema: SchemaValidator,
    @Inject(CONNECTION_REPOSITORY) private readonly connections: ConnectionRepository,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  private readonly tracer = getTracer('aia-mcp-gateway');

  /**
   * Runs the tool inside a span named by the GenAI conventions.
   *
   * The gateway performs the platform's highest-risk operation -- a call with a
   * risk level, a human approval gate and an audit row -- and produced no span
   * at all. A refusal was a row in Mongo and nothing a trace could show, so the
   * question "what did this run try to do, and what stopped it" had two halves
   * that could not be joined.
   */
  async execute(command: InvokeToolCommand, principal: Principal): Promise<InvocationResultView> {
    return this.tracer.startActiveSpan(
      `${GEN_AI_SPAN.EXECUTE_TOOL} ${command.toolId}`,
      {
        attributes: {
          [GEN_AI_ATTR.OPERATION_NAME]: GEN_AI_SPAN.EXECUTE_TOOL,
          'gen_ai.tool.call.id': command.toolId,
          [AIA_ATTR.PROJECT_ID]: command.projectId,
          [AIA_ATTR.PRINCIPAL_ID]: command.principalId,
          // Whether the caller arrived holding an approval. The gateway's own
          // decision -- whether one was REQUIRED -- is set below, once the tool
          // is resolved and the binding is known.
          'aia.tool.approval_presented': command.approvalId !== undefined,
        },
      },
      async (span) => {
        try {
          const result = await this.invoke(command, principal, span);
          span.setAttribute('aia.tool.outcome', result.status);
          return result;
        } catch (error) {
          const code = (error as { code?: string }).code;
          span.setAttribute('aia.tool.outcome', code ?? 'failed');

          // An approval request is NOT an error, and marking it as one would
          // make the platform look broken every time it did its job: a project
          // whose tools all require approval would show a hundred per cent
          // error rate on the one control that is working. It is recorded as an
          // outcome instead, the same distinction the budget rejections make.
          if (!(error instanceof ApprovalRequiredError)) {
            recordSpanError(span, error, code);
          }
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private async invoke(
    command: InvokeToolCommand,
    principal: Principal,
    span: Span,
  ): Promise<InvocationResultView> {
    const tool = await this.catalog.find({
      projectId: command.projectId,
      accessToken: command.accessToken,
      toolId: command.toolId,
    });
    if (tool === null) throw new ToolNotFoundError(command.toolId);

    const binding = await this.bindings.find(command.projectId, command.toolId);

    let decision;
    try {
      decision = decideInvocation({
        principal,
        projectId: command.projectId,
        tool,
        binding,
      });
    } catch (error) {
      await this.recordDenial(command, tool, error);
      throw error;
    }

    // Before the rate limit, for the same reason the rate limit is after the
    // decision: a call refused for being malformed must not spend somebody
    // else's allowance. Before the approval too -- asking a person to approve
    // arguments that cannot run wastes the one reviewer this control has.
    await this.assertArgumentsMatchSchema(command, tool);

    // The rate is consumed AFTER the decision: a refused call must not spend
    // somebody else's allowance.
    const limited = await this.limiter.consume({
      key: `${command.projectId}:${command.toolId}`,
      limitPerMinute: binding?.effectiveRateLimit ?? 60,
    });
    if (limited !== null) {
      const error = new ToolRateLimitedError(command.toolId, limited.retryAfterSeconds);
      await this.recordDenial(command, tool, error);
      throw error;
    }

    span.setAttributes({
      'aia.tool.risk_level': tool.riskLevel,
      'aia.tool.type': tool.toolType,
      'aia.tool.requires_approval': decision.requiresApproval,
    });

    if (decision.requiresApproval) {
      await this.assertApproved(command, tool);
    }

    const started = this.clock.now();
    const executor = this.executors.find((candidate) => candidate.supports(tool.toolType));
    if (executor === undefined) {
      throw new ToolExecutionFailedError(
        tool.toolId,
        `No executor is configured for a ${tool.toolType} tool`,
      );
    }

    const credential = await this.credentialFor(command.projectId, tool);

    try {
      const outcome = await executor.execute({
        tool,
        arguments: command.arguments,
        // The USER's token, not the gateway's: a BUILT-IN reaches another AIA
        // service and acts as them (ADR-017). An external executor must not
        // touch it -- see the comment on `ToolInvocation.accessToken`.
        accessToken: command.accessToken,
        ...(credential !== null && { credential }),
        projectId: command.projectId,
        principalId: command.principalId,
      });

      await this.record(command, tool, {
        status: 'ok',
        durationMs: outcome.durationMs,
        occurredAt: started,
      });

      return {
        toolId: tool.toolId,
        status: 'ok',
        result: outcome.result,
        durationMs: outcome.durationMs,
      };
    } catch (error) {
      await this.record(command, tool, {
        status: 'failed',
        durationMs: this.clock.now().getTime() - started.getTime(),
        occurredAt: started,
        errorCode: codeOf(error),
      });
      if (error instanceof ToolExecutionFailedError) throw error;
      throw new ToolExecutionFailedError(tool.toolId, String(error));
    }
  }

  /**
   * Approval is bound to the ARGUMENTS, not just the tool.
   *
   * Otherwise a human approves "read ticket 42" and the caller replays the
   * approval with "delete everything" -- the signature has to cover what was
   * signed for.
   */
  private async assertApproved(command: InvokeToolCommand, tool: ToolDefinition): Promise<void> {
    const hash = hashArguments(command.arguments);

    if (command.approvalId === undefined) {
      const approvalId = this.ids.next();
      await this.approvals.open(
        {
          id: approvalId,
          projectId: command.projectId,
          toolId: command.toolId,
          principalId: command.principalId,
          argumentsHash: hash,
          createdAt: this.clock.now(),
        },
        APPROVAL_TTL_SECONDS,
      );

      await this.record(command, tool, {
        status: 'approval_required',
        durationMs: 0,
        occurredAt: this.clock.now(),
        approvalId,
      });

      throw new ApprovalRequiredError(command.toolId, approvalId, tool.riskLevel);
    }

    const pending = await this.approvals.take({
      projectId: command.projectId,
      approvalId: command.approvalId,
    });
    if (pending === null) {
      throw new ToolNotAllowedError(
        command.toolId,
        'That approval has expired or was already used',
      );
    }
    if (pending.toolId !== command.toolId || pending.argumentsHash !== hash) {
      throw new ToolNotAllowedError(
        command.toolId,
        'That approval was granted for a different call',
      );
    }
  }

  /**
   * The credential a tool's connection stands for, resolved for this one call.
   *
   * A tool naming a connection that does not resolve fails HERE, before the
   * request goes out. Sending it without the credential would reach the
   * endpoint as an anonymous call and come back as a 401 the model then has to
   * interpret, when the real fault is a secret nobody mounted.
   */
  private async credentialFor(
    projectId: string,
    tool: ToolDefinition,
  ): Promise<ResolvedCredential | null> {
    if (tool.connectionId === undefined) return null;

    const connection = await this.connections.find(projectId, tool.connectionId);
    if (connection === null) {
      throw new ToolExecutionFailedError(tool.toolId, 'The tool names a connection that is gone');
    }
    if (!connection.needsSecret) return null;

    const secret = await this.secrets.resolve(connection.secretRef);
    if (secret === null) {
      // The reference, never the value -- and there is no value to leak here
      // anyway, which is the point.
      throw new ToolExecutionFailedError(
        tool.toolId,
        `The secret "${connection.secretRef}" is not available on this host`,
      );
    }

    return connection.credentialWith(secret);
  }

  private async record(
    command: InvokeToolCommand,
    tool: ToolDefinition,
    outcome: {
      status: 'ok' | 'failed' | 'denied' | 'approval_required';
      durationMs: number;
      occurredAt: Date;
      errorCode?: string;
      approvalId?: string;
    },
  ): Promise<void> {
    await this.audit.record(
      {
        id: this.ids.next(),
        projectId: command.projectId,
        principalId: command.principalId,
        toolId: tool.toolId,
        toolType: tool.toolType,
        riskLevel: tool.riskLevel,
        status: outcome.status,
        ...(currentTraceId() !== undefined && { traceId: currentTraceId() }),
        ...(outcome.errorCode !== undefined && { errorCode: outcome.errorCode }),
        ...(outcome.approvalId !== undefined && { approvalId: outcome.approvalId }),
        durationMs: outcome.durationMs,
        occurredAt: outcome.occurredAt,
      },
      outcome.status === 'ok'
        ? [
            newEvent({
              type: EVENT_TYPES.TOOL_INVOKED,
              source: SOURCE,
              projectId: command.projectId,
              data: {
                tool_id: tool.toolId,
                tool_type: tool.toolType,
                risk_level: tool.riskLevel,
                principal_id: command.principalId,
                duration_ms: outcome.durationMs,
              },
            }),
          ]
        : [],
    );
  }

  /** A refusal is audited too: who was told no, and why, is the useful half. */
  /**
   * OWASP LLM05: what the model asked for has to match what the tool declares.
   *
   * A tool with no declared parameters is not validated, and that is a real
   * decision rather than an omission: `parameters` is optional in the registry,
   * and treating "undeclared" as "nothing is allowed" would break every tool
   * that takes free-form input. What it does mean is that a tool wanting this
   * protection has to declare a schema -- which the registry already validates
   * at publish time.
   */
  private async assertArgumentsMatchSchema(
    command: InvokeToolCommand,
    tool: ToolDefinition,
  ): Promise<void> {
    if (tool.parameters === undefined) return;

    const reasons = this.schema.validate({
      schema: tool.parameters,
      value: command.arguments,
    });
    if (reasons.length === 0) return;

    const error = new ToolArgumentsInvalidError(tool.toolId, reasons);
    await this.recordDenial(command, tool, error);
    throw error;
  }

  private async recordDenial(
    command: InvokeToolCommand,
    tool: ToolDefinition,
    error: unknown,
  ): Promise<void> {
    await this.record(command, tool, {
      status: 'denied',
      durationMs: 0,
      occurredAt: this.clock.now(),
      errorCode: codeOf(error),
    });
  }
}

export function hashArguments(args: Record<string, unknown>): string {
  // Keys sorted, so the same call hashes the same however it was serialised.
  return createHash('sha256').update(stableStringify(args)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'tool_execution_failed';
}

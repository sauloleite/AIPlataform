/**
 * Application layer ports.
 *
 * A use case knows a tool can be invoked and that a rate can be consumed; it
 * never knows MCP, HTTP or Redis.
 */
import type { CloudEvent } from '@aia/messaging';

import type { Connection } from '../domain/entities/connection.js';
import type { ToolBinding } from '../domain/entities/tool-binding.js';
import type { ToolDefinition } from '../domain/value-objects/index.js';

/**
 * The registry's published tool assets.
 *
 * Read over the contract, as the caller: the gateway never imports another
 * service's domain, and it never needs read access to projects it is not
 * being asked about (ADR-017).
 */
export interface ToolCatalog {
  find(input: {
    projectId: string;
    accessToken: string;
    toolId: string;
  }): Promise<ToolDefinition | null>;
  list(input: { projectId: string; accessToken: string }): Promise<ToolDefinition[]>;
}
export const TOOL_CATALOG = Symbol('ToolCatalog');

/** A credential already shaped into the header the endpoint expects. */
export interface ResolvedCredential {
  readonly header: string;
  readonly value: string;
}

export interface ToolInvocation {
  readonly tool: ToolDefinition;
  readonly arguments: Record<string, unknown>;
  /**
   * The caller's platform token.
   *
   * Only a built-in may use it, because a built-in reaches another AIA service.
   * An EXTERNAL endpoint must never see it: it is a valid platform JWT, and
   * handing one to a third party lets that third party act as the user against
   * this platform. External executors take `credential` instead.
   */
  readonly accessToken: string;
  /** The tool's connection, resolved. Absent when it needs none. */
  readonly credential?: ResolvedCredential;
  readonly projectId: string;
  readonly principalId: string;
}

export interface ToolOutcome {
  readonly result: unknown;
  readonly durationMs: number;
}

/** One executor per tool type. Chosen by `supports`, never by a switch. */
export interface ToolExecutor {
  supports(toolType: string): boolean;
  execute(invocation: ToolInvocation): Promise<ToolOutcome>;
}
export const TOOL_EXECUTORS = Symbol('ToolExecutors');

/**
 * Checks the arguments a model produced against the schema the tool declares.
 *
 * A port rather than a direct call, because JSON Schema evaluation is a library
 * (Ajv compiles and caches), and an adapter is where a library belongs. The
 * RULE -- untrusted arguments are checked before anything runs -- is the
 * gateway's; the dialect is not.
 *
 * Returns the reasons rather than throwing, so the use case decides the error
 * and the audit record, and a validator is testable without one.
 */
export interface SchemaValidator {
  /**
   * Empty when the arguments satisfy the schema.
   *
   * A schema this validator cannot compile is a REJECTION, never a pass: a tool
   * published with a broken schema must not become the one tool nobody checks.
   */
  validate(input: { schema: Record<string, unknown>; value: unknown }): readonly string[];
}
export const SCHEMA_VALIDATOR = Symbol('SchemaValidator');

export interface RateLimiter {
  /**
   * Consumes one unit. Returns how long to wait when the window is full, or
   * null when the call may proceed.
   */
  consume(input: {
    key: string;
    limitPerMinute: number;
  }): Promise<{ retryAfterSeconds: number } | null>;
}
export const RATE_LIMITER = Symbol('RateLimiter');

export interface BindingRepository {
  find(projectId: string, toolId: string): Promise<ToolBinding | null>;
  list(projectId: string): Promise<ToolBinding[]>;
  save(binding: ToolBinding): Promise<void>;
  remove(projectId: string, toolId: string): Promise<void>;
}
export const BINDING_REPOSITORY = Symbol('BindingRepository');

export interface InvocationRecord {
  id: string;
  projectId: string;
  principalId: string;
  toolId: string;
  toolType: string;
  riskLevel: string;
  status: 'ok' | 'failed' | 'denied' | 'approval_required';
  errorCode?: string;
  durationMs: number;
  approvalId?: string;
  occurredAt: Date;
}

/** Every invocation is audited with the identity that made it. */
export interface AuditRepository {
  record(entry: InvocationRecord, events?: readonly CloudEvent[]): Promise<void>;
}
export const AUDIT_REPOSITORY = Symbol('AuditRepository');

export interface PendingApproval {
  id: string;
  projectId: string;
  toolId: string;
  principalId: string;
  argumentsHash: string;
  createdAt: Date;
}

/**
 * Approvals that are waiting on a human.
 *
 * Short-lived on purpose: an approval that outlives the intent behind it is a
 * signature on a blank cheque.
 */
export interface ApprovalStore {
  open(approval: PendingApproval, ttlSeconds: number): Promise<void>;
  take(input: { projectId: string; approvalId: string }): Promise<PendingApproval | null>;
}
export const APPROVAL_STORE = Symbol('ApprovalStore');

export interface ConnectionRepository {
  find(projectId: string, connectionId: string): Promise<Connection | null>;
  findBySlug(projectId: string, slug: string): Promise<Connection | null>;
  list(projectId: string): Promise<Connection[]>;
  save(connection: Connection): Promise<void>;
  remove(projectId: string, connectionId: string): Promise<boolean>;
}
export const CONNECTION_REPOSITORY = Symbol('ConnectionRepository');

/**
 * Where a secret actually lives.
 *
 * A port because ADR-015 has three answers depending on where the platform
 * runs -- a file under `/run/secrets`, an environment variable, or a cluster
 * secret mounted as either. The service is written against the question, not
 * against one of the answers.
 */
export interface SecretResolver {
  resolve(secretRef: string): Promise<string | null>;
}
export const SECRET_RESOLVER = Symbol('SecretResolver');

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

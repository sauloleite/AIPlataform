import type { AuditRecord } from '../../application/ports.js';

/**
 * The audit record on the wire.
 *
 * Snake_case like the rest of the contract, and explicit about the content: a
 * record kept by a project that does not capture content is not an empty
 * conversation, and `content_captured` is what keeps those two apart. Reading
 * `prompt: null` as "nothing was said" is the mistake this field exists to
 * prevent.
 */
export function toCompletionRecordResponse(record: AuditRecord): Record<string, unknown> {
  const captured = record.redactedPrompt !== undefined || record.redactedCompletion !== undefined;

  return {
    request_id: record.requestId,
    project_id: record.projectId,
    principal_id: record.principalId,
    alias: record.alias,
    deployment_id: record.deploymentId,
    provider: record.provider,
    data_zone: record.dataZone,
    status: record.status,
    prompt_tokens: record.promptTokens,
    completion_tokens: record.completionTokens,
    cost_micros: record.costMicros,
    currency: record.currency,
    duration_ms: record.durationMs,
    error_code: record.errorCode ?? null,
    guardrails_unverified: record.guardrailsUnverified,
    content_captured: captured,
    // Redacted at the moment it was written, never at read time: a record that
    // needed redacting on the way out would have been stored unredacted.
    prompt: record.redactedPrompt ?? null,
    completion: record.redactedCompletion ?? null,
    occurred_at: record.occurredAt.toISOString(),
    expires_at: record.expiresAt.toISOString(),
  };
}

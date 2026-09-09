import { describe, expect, it } from 'vitest';
import { POLICY, authorize, type Principal } from '@aia/auth';
import { ForbiddenError, NotFoundError } from '@aia/errors';

import { ReadCompletionRecord } from '../src/modules/completions/application/use-cases/read-completion-record.js';
import { toCompletionRecordResponse } from '../src/modules/completions/presentation/mappers/audit.mapper.js';
import type { AuditRecord } from '../src/modules/completions/application/ports.js';
import { FakeAuditRepository } from './fakes.js';

function aRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    requestId: 'req-1',
    projectId: 'proj-1',
    principalId: 'user-ana',
    alias: 'chat-local',
    deploymentId: 'dep-1',
    provider: 'ollama',
    dataZone: 'local',
    status: 'completed',
    promptTokens: 12,
    completionTokens: 30,
    costMicros: 300,
    currency: 'BRL',
    durationMs: 2400,
    guardrailsUnverified: false,
    expiresAt: new Date('2026-12-09T00:00:00Z'),
    occurredAt: new Date('2026-09-09T12:00:00Z'),
    ...overrides,
  };
}

async function repositoryWith(...records: AuditRecord[]): Promise<FakeAuditRepository> {
  const repository = new FakeAuditRepository();
  for (const record of records) await repository.record(record);
  return repository;
}

function aPrincipal(roles: string[], projectId = 'proj-1'): Principal {
  return {
    id: 'user-ana',
    type: 'user',
    issuer: 'https://identity.local',
    expiresAt: Date.now() / 1000 + 3600,
    globalRoles: [],
    memberships: [{ projectId, roles }],
    scopes: [],
  } as unknown as Principal;
}

describe('reading one inference record', () => {
  it('returns what the audit kept', async () => {
    const useCase = new ReadCompletionRecord(await repositoryWith(aRecord()));

    const record = await useCase.execute({ projectId: 'proj-1', requestId: 'req-1' });

    expect(record.alias).toBe('chat-local');
    expect(record.costMicros).toBe(300);
  });

  it("another project's record is not found rather than forbidden", async () => {
    // Confirming that a request id exists is already a fact about the
    // neighbouring tenant, and this record carries their conversation.
    const useCase = new ReadCompletionRecord(await repositoryWith(aRecord()));

    await expect(
      useCase.execute({ projectId: 'proj-2', requestId: 'req-1' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an id nobody recorded is not found', async () => {
    const useCase = new ReadCompletionRecord(await repositoryWith(aRecord()));

    await expect(
      useCase.execute({ projectId: 'proj-1', requestId: 'req-9' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('who may read one', () => {
  it('an owner and an auditor may', () => {
    for (const role of ['project_owner', 'auditor']) {
      expect(() =>
        authorize(POLICY.READ_AUDIT, { principal: aPrincipal([role]), projectId: 'proj-1' }),
      ).not.toThrow();
    }
  });

  it('a member who can use the platform still may not read what it said', () => {
    // The distinction the rest of this controller does not make: using the
    // platform and reading somebody else's conversation are different rights.
    expect(() =>
      authorize(POLICY.READ_AUDIT, {
        principal: aPrincipal(['project_editor']),
        projectId: 'proj-1',
      }),
    ).toThrow(ForbiddenError);
  });

  it('an owner of a different project may not', () => {
    expect(() =>
      authorize(POLICY.READ_AUDIT, {
        principal: aPrincipal(['project_owner'], 'proj-2'),
        projectId: 'proj-1',
      }),
    ).toThrow(ForbiddenError);
  });
});

describe('the record on the wire', () => {
  it('says the project keeps no content, rather than showing an empty conversation', () => {
    const body = toCompletionRecordResponse(aRecord());

    expect(body.content_captured).toBe(false);
    expect(body.prompt).toBeNull();
  });

  it('carries the redacted content when the project opted in', () => {
    const body = toCompletionRecordResponse(
      aRecord({ redactedPrompt: 'how do I restart?', redactedCompletion: 'Drain traffic first.' }),
    );

    expect(body.content_captured).toBe(true);
    expect(body.prompt).toBe('how do I restart?');
  });

  it('a call that failed is still readable, with its error code', () => {
    const body = toCompletionRecordResponse(aRecord({ status: 'failed', errorCode: 'timeout' }));

    expect(body.status).toBe('failed');
    expect(body.error_code).toBe('timeout');
  });
});

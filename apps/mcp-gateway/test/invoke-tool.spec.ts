import { describe, expect, it } from 'vitest';
import { ROLES } from '@aia/auth';

import type { RiskLevel } from '../src/modules/tools/domain/value-objects/index.js';

import { aCommand, aPrincipal, aTool, build } from './invoke-tool-harness.js';

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

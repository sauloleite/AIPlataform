import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ROLES } from '@aia/auth';
import { AIA_ATTR } from '@aia/telemetry';

import { ApprovalRequiredError } from '../src/modules/tools/domain/errors/index.js';
import { PROJECT, aCommand, aPrincipal, aTool, build } from './invoke-tool-harness.js';

/**
 * What a governed tool call leaves behind in a trace.
 *
 * The gateway performs the platform's highest-risk operation — a call carrying
 * a risk level, a human approval gate and an audit row — and produced no span
 * at all. A refusal existed as a row in Mongo and as nothing a trace could
 * show, so "what did this run try to do, and what stopped it" had two halves
 * with no join between them.
 */

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

function spanNamed(prefix: string) {
  return exporter.getFinishedSpans().find((span) => span.name.startsWith(prefix));
}

describe('the span of a tool invocation', () => {
  it('names the operation the way the GenAI conventions do', async () => {
    await build().useCase.execute(aCommand({ query: 'leave' }), aPrincipal());

    const span = spanNamed('execute_tool');
    expect(span, 'the invocation produced no span').toBeDefined();
    expect(span?.attributes[AIA_ATTR.PROJECT_ID]).toBe(PROJECT);
  });

  it('records the risk level and whether an approval was required', async () => {
    const { useCase } = build(aTool({ riskLevel: 'high' }));

    await expect(
      useCase.execute(aCommand({ query: 'leave' }), aPrincipal([ROLES.PROJECT_OWNER])),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);

    const span = spanNamed('execute_tool');
    // The refusal is the interesting case. It used to be a Mongo row and
    // nothing else: an auditor reading it had no way back to the run.
    expect(span?.attributes['aia.tool.risk_level']).toBe('high');
    expect(span?.attributes['aia.tool.requires_approval']).toBe(true);
    expect(span?.attributes['aia.tool.approval_presented']).toBe(false);
  });

  it('does not mark a held call as an error, because it is not one', async () => {
    const { useCase } = build(aTool({ riskLevel: 'high' }));

    await expect(
      useCase.execute(aCommand({ query: 'leave' }), aPrincipal([ROLES.PROJECT_OWNER])),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);

    const span = spanNamed('execute_tool');
    // A project whose tools all require approval would otherwise show a
    // hundred per cent error rate on the one control that is working. The
    // outcome is recorded instead, the same distinction budget rejections make.
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['aia.tool.outcome']).toBe('approval_required');
  });

  it('does mark a genuine failure as one', async () => {
    const { useCase } = build();

    // Arguments the schema refuses: a real fault, and the trace has to say so
    // or an error rate computed from spans reads zero while calls fail.
    await expect(useCase.execute(aCommand({}), aPrincipal())).rejects.toThrow();

    expect(spanNamed('execute_tool')?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('puts the trace id on the audit row, so the two accounts join', async () => {
    const { useCase, audit } = build();

    await useCase.execute(aCommand({ query: 'leave' }), aPrincipal());

    const traceId = spanNamed('execute_tool')?.spanContext().traceId;
    expect(traceId).toBeDefined();
    expect(audit.entries[0]?.traceId).toBe(traceId);
  });
});

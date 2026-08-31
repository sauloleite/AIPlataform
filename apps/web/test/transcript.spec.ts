import { describe, expect, it } from 'vitest';

import {
  applyRunEvent,
  openTranscript,
  resumed,
  type RunStreamEvent,
  type RunTranscript,
} from '../src/modules/agents/domain/transcript';

/**
 * Folding a run's events into what the playground shows.
 *
 * The reducer is where the trace is either honest or misleading: a result
 * attached to the wrong call, or a held tool rendered as one that ran, is a
 * user reading a confident answer that never happened.
 */

function fold(events: RunStreamEvent[], from = openTranscript('how much leave?')): RunTranscript {
  return events.reduce(applyRunEvent, from);
}

const started: RunStreamEvent = { name: 'run.started', data: { run_id: 'run-1' } };

function delta(content: string): RunStreamEvent {
  return { name: 'message.delta', data: { content } };
}

function toolCall(id: string, name: string, args: unknown = { q: 'leave' }): RunStreamEvent {
  return { name: 'tool.call', data: { tool_call_id: id, tool_name: name, arguments: args } };
}

function toolResult(id: string, status: string, result?: unknown): RunStreamEvent {
  return { name: 'tool.result', data: { tool_call_id: id, status, result } };
}

describe('a plain answer', () => {
  it('joins the deltas into one assistant turn', () => {
    const transcript = fold([started, delta('You get '), delta('30 days.')]);

    expect(transcript.runId).toBe('run-1');
    expect(transcript.entries).toEqual([
      { kind: 'user', text: 'how much leave?' },
      { kind: 'assistant', text: 'You get 30 days.' },
    ]);
  });

  it('finishes as completed', () => {
    const transcript = fold([
      started,
      delta('Done.'),
      { name: 'run.finished', data: { run_id: 'run-1', status: 'completed' } },
    ]);

    expect(transcript.phase).toBe('completed');
    expect(transcript.error).toBeUndefined();
  });

  it('ignores an empty delta rather than opening a blank turn', () => {
    const transcript = fold([started, delta('')]);

    expect(transcript.entries).toHaveLength(1);
  });

  it('ignores an event this version does not know about', () => {
    // The platform may emit more than this console reads; that is not a failure.
    const transcript = fold([started, { name: 'usage.recorded', data: { tokens: 12 } }]);

    expect(transcript.phase).toBe('running');
    expect(transcript.entries).toHaveLength(1);
  });
});

describe('the tool trace', () => {
  it('shows a call and then settles it in place', () => {
    const transcript = fold([
      started,
      toolCall('c1', 'knowledge-search'),
      toolResult('c1', 'ok', '30 days'),
    ]);

    expect(transcript.entries[1]).toEqual({
      kind: 'tool',
      callId: 'c1',
      name: 'knowledge-search',
      args: { q: 'leave' },
      status: 'ok',
      result: '30 days',
    });
  });

  it('settles the right call when two are in flight', () => {
    // The failure this guards: a result landing on whichever call is last, so
    // the trace says the wrong tool succeeded.
    const transcript = fold([
      started,
      toolCall('c1', 'knowledge-search'),
      toolCall('c2', 'merge-request'),
      toolResult('c1', 'ok'),
    ]);

    const [, first, second] = transcript.entries;
    expect(first).toMatchObject({ callId: 'c1', status: 'ok' });
    expect(second).toMatchObject({ callId: 'c2', status: 'running' });
  });

  it('keeps a failed call visible as failed', () => {
    const transcript = fold([
      started,
      toolCall('c1', 'knowledge-search'),
      toolResult('c1', 'failed'),
    ]);

    expect(transcript.entries[1]).toMatchObject({ status: 'failed' });
  });

  it('reads a status it does not recognise as a failure, never as success', () => {
    const transcript = fold([started, toolCall('c1', 'x'), toolResult('c1', 'something-new')]);

    expect(transcript.entries[1]).toMatchObject({ status: 'failed' });
  });

  it('starts a new assistant turn after a tool call', () => {
    // Otherwise the answer before the call and the answer after it merge into
    // one paragraph with the trace buried in the middle.
    const transcript = fold([
      started,
      delta('Let me look.'),
      toolCall('c1', 'knowledge-search'),
      toolResult('c1', 'ok'),
      delta('You get 30 days.'),
    ]);

    expect(transcript.entries.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });
});

describe('an approval', () => {
  const held: RunStreamEvent = {
    name: 'approval.requested',
    data: {
      run_id: 'run-1',
      tool_call_id: 'c1',
      tool_name: 'merge-request',
      risk_level: 'high',
      arguments: { mr: 42 },
    },
  };

  it('holds the run and surfaces what is waiting', () => {
    const transcript = fold([started, held]);

    expect(transcript.phase).toBe('waiting_approval');
    expect(transcript.awaiting).toEqual({
      callId: 'c1',
      name: 'merge-request',
      args: { mr: 42 },
      riskLevel: 'high',
    });
  });

  it('shows the held call in the trace as not yet run', () => {
    // The status is what stops the trace reading as though it already ran.
    const transcript = fold([started, held]);

    expect(transcript.entries[1]).toMatchObject({
      kind: 'tool',
      callId: 'c1',
      status: 'awaiting_approval',
    });
  });

  it('learns the run id from the approval when the stream opened without one', () => {
    const transcript = fold([held]);

    expect(transcript.runId).toBe('run-1');
  });

  it('clears the prompt on resume so nobody approves the same call twice', () => {
    const waiting = fold([started, held]);

    const reopened = resumed(waiting);

    expect(reopened.awaiting).toBeUndefined();
    expect(reopened.phase).toBe('running');
    // The trace is kept: the held call still happened.
    expect(reopened.entries).toHaveLength(2);
  });

  it('settles the held entry once the resumed run reports it', () => {
    const waiting = fold([started, held]);

    const after = fold([toolResult('c1', 'ok', 'merged')], resumed(waiting));

    expect(after.entries[1]).toMatchObject({ status: 'ok', result: 'merged' });
  });

  it('settles it as denied when the person refuses', () => {
    const waiting = fold([started, held]);

    const after = fold([toolResult('c1', 'denied')], resumed(waiting));

    expect(after.entries[1]).toMatchObject({ status: 'denied' });
  });
});

describe('a failure', () => {
  it('reports an error event and stops the run', () => {
    const transcript = fold([
      started,
      { name: 'error', data: { code: 'budget_exhausted', message: 'No budget left.' } },
    ]);

    expect(transcript.phase).toBe('failed');
    expect(transcript.error).toEqual({ code: 'budget_exhausted', message: 'No budget left.' });
  });

  it('reports a run that failed on the step limit', () => {
    const transcript = fold([
      started,
      { name: 'run.finished', data: { status: 'failed', error_code: 'agent_step_limit' } },
    ]);

    expect(transcript.phase).toBe('failed');
    expect(transcript.error?.code).toBe('agent_step_limit');
  });

  it('falls back to a readable message when the platform sent none', () => {
    const transcript = fold([started, { name: 'error', data: {} }]);

    expect(transcript.error).toEqual({ code: 'internal_error', message: 'The run failed.' });
  });
});

describe('a call the runtime refused before sending it', () => {
  it('shows a blocked retrieval as blocked, not as failed', () => {
    // The agent was not attached to the store the model named. It reads
    // differently from a tool that ran and broke, and the trace should say so.
    const transcript = fold([
      started,
      toolCall('c1', 'knowledge-search', { query: 'x', store_id: 'someone-elses' }),
      toolResult('c1', 'blocked', { detail: 'not attached' }),
    ]);

    expect(transcript.entries[1]).toMatchObject({ status: 'blocked' });
  });

  it('shows an invented tool name as unknown', () => {
    const transcript = fold([started, toolCall('c1', 'rm_rf'), toolResult('c1', 'unknown_tool')]);

    expect(transcript.entries[1]).toMatchObject({ status: 'unknown_tool' });
  });
});

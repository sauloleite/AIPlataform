/**
 * Folding a run's event stream into something a person can read.
 *
 * Domain, not infrastructure: it opens nothing and calls nothing. It is a pure
 * reducer over events that already arrived, which is what lets the same rule be
 * tested without a server and run in the browser.
 *
 * A tool call is an entry in its own right, not a line of prose, because the
 * trace is the point: seeing WHICH tool ran with WHICH arguments is how anyone
 * tells a good answer from a confident one.
 */

export type ToolStatus =
  'awaiting_approval' | 'running' | 'ok' | 'failed' | 'denied' | 'blocked' | 'unknown_tool';

export type RunEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      callId: string;
      name: string;
      args: unknown;
      status: ToolStatus;
      result?: unknown;
    };

export type RunPhase = 'running' | 'waiting_approval' | 'completed' | 'failed';

export interface Awaiting {
  callId: string;
  name: string;
  args: unknown;
  riskLevel: string;
}

export interface RunTranscript {
  runId: string;
  phase: RunPhase;
  entries: RunEntry[];
  awaiting?: Awaiting;
  error?: { code: string; message: string };
}

export interface RunStreamEvent {
  name: string;
  data: unknown;
}

export function openTranscript(userInput: string): RunTranscript {
  return { runId: '', phase: 'running', entries: [{ kind: 'user', text: userInput }] };
}

/** Reopens a transcript for a resumed run: the approval prompt is cleared.
 *
 * Built field by field rather than spread-and-override, because `awaiting` has
 * to be ABSENT: left present, the prompt renders again and the same call can be
 * approved twice. */
export function resumed(transcript: RunTranscript): RunTranscript {
  return {
    runId: transcript.runId,
    phase: 'running',
    entries: transcript.entries,
    ...(transcript.error !== undefined && { error: transcript.error }),
  };
}

export function applyRunEvent(transcript: RunTranscript, event: RunStreamEvent): RunTranscript {
  const data = asRecord(event.data);

  switch (event.name) {
    case 'run.started':
      return { ...transcript, runId: text(data['run_id']) };

    case 'message.delta':
      return { ...transcript, entries: appendDelta(transcript.entries, text(data['content'])) };

    case 'tool.call':
      return {
        ...transcript,
        entries: [
          ...transcript.entries,
          {
            kind: 'tool',
            callId: text(data['tool_call_id']),
            name: text(data['tool_name']),
            args: data['arguments'],
            status: 'running',
          },
        ],
      };

    case 'tool.result':
      return {
        ...transcript,
        entries: settle(
          transcript.entries,
          text(data['tool_call_id']),
          toolStatus(text(data['status'])),
          data['result'],
        ),
      };

    case 'approval.requested': {
      const awaiting: Awaiting = {
        callId: text(data['tool_call_id']),
        name: text(data['tool_name']),
        args: data['arguments'],
        riskLevel: text(data['risk_level']) || 'high',
      };
      return {
        ...transcript,
        runId: text(data['run_id']) || transcript.runId,
        phase: 'waiting_approval',
        awaiting,
        // The held call is shown in the trace too, so the prompt is not the
        // only place it appears: scrolling away must not lose it.
        entries: [
          ...transcript.entries,
          {
            kind: 'tool',
            callId: awaiting.callId,
            name: awaiting.name,
            args: awaiting.args,
            status: 'awaiting_approval',
          },
        ],
      };
    }

    case 'run.finished':
      return {
        ...transcript,
        runId: text(data['run_id']) || transcript.runId,
        phase: text(data['status']) === 'completed' ? 'completed' : 'failed',
        ...(text(data['error_code']) !== '' && {
          error: { code: text(data['error_code']), message: text(data['error_code']) },
        }),
      };

    case 'error':
      return {
        ...transcript,
        phase: 'failed',
        error: {
          code: text(data['code']) || 'internal_error',
          message: text(data['message']) || 'The run failed.',
        },
      };

    default:
      // An event this console does not know about is not a failure: the
      // platform may emit more than this version reads.
      return transcript;
  }
}

/**
 * Deltas append to the assistant entry in progress.
 *
 * A new one is opened only when the last entry is not an assistant turn, so a
 * tool call between two bursts of text produces two separate answers rather
 * than one paragraph with the trace buried in the middle.
 */
function appendDelta(entries: RunEntry[], content: string): RunEntry[] {
  if (content === '') return entries;

  const last = entries.at(-1);
  if (last?.kind === 'assistant') {
    return [...entries.slice(0, -1), { kind: 'assistant', text: last.text + content }];
  }
  return [...entries, { kind: 'assistant', text: content }];
}

function settle(
  entries: RunEntry[],
  callId: string,
  status: ToolStatus,
  result: unknown,
): RunEntry[] {
  return entries.map((entry) =>
    entry.kind === 'tool' && entry.callId === callId
      ? { ...entry, status, ...(result !== undefined && { result }) }
      : entry,
  );
}

const TOOL_STATUSES: ToolStatus[] = ['ok', 'failed', 'denied', 'blocked', 'unknown_tool'];

function toolStatus(raw: string): ToolStatus {
  return TOOL_STATUSES.includes(raw as ToolStatus) ? (raw as ToolStatus) : 'failed';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

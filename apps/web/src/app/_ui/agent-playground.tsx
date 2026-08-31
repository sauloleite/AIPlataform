'use client';

import {
  Badge,
  Button,
  Card,
  Spinner,
  Text,
  Textarea,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Play16Regular, ShieldTask20Regular } from '@fluentui/react-icons';
import { useCallback, useRef, useState, type ReactElement } from 'react';

import { parseSse } from '../../modules/console/domain/sse';
import {
  applyRunEvent,
  openTranscript,
  resumed,
  type RunEntry,
  type RunTranscript,
  type ToolStatus,
} from '../../modules/agents/domain/transcript';

const useStyles = makeStyles({
  card: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column' },
  transcript: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxHeight: '46vh',
    overflowY: 'auto',
    marginBlock: tokens.spacingVerticalM,
  },
  user: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusLarge,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  assistant: { whiteSpace: 'pre-wrap' },
  trace: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflowX: 'auto',
  },
  traceHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBlockEnd: tokens.spacingVerticalXS,
  },
  args: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  approval: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  buttons: { display: 'flex', gap: tokens.spacingHorizontalS },
  composer: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  error: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

const TOOL_TONE: Record<ToolStatus, 'success' | 'warning' | 'danger' | 'informative'> = {
  ok: 'success',
  running: 'informative',
  awaiting_approval: 'warning',
  denied: 'warning',
  blocked: 'warning',
  failed: 'danger',
  unknown_tool: 'danger',
};

export function AgentPlayground({
  projectId,
  agentId,
  publishable,
}: {
  projectId: string;
  agentId: string;
  publishable: boolean;
}): ReactElement {
  const styles = useStyles();
  const [draft, setDraft] = useState('');
  const [transcript, setTranscript] = useState<RunTranscript | undefined>();
  const [busy, setBusy] = useState(false);
  // The thread carries across turns, so a second question continues the same
  // conversation rather than starting a stranger.
  const threadRef = useRef<string | undefined>(undefined);

  const consume = useCallback(async (response: Response, from: RunTranscript): Promise<void> => {
    if (!response.ok || response.body === null) {
      const problem = (await response.json().catch(() => ({}))) as { detail?: string };
      setTranscript({
        ...from,
        phase: 'failed',
        error: { code: 'request_failed', message: problem.detail ?? 'The run could not start.' },
      });
      return;
    }

    let current = from;
    for await (const event of parseSse(response.body)) {
      current = applyRunEvent(current, event);
      setTranscript(current);
    }
  }, []);

  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || busy) return;

    setBusy(true);
    setDraft('');
    const opened = openTranscript(text);
    setTranscript(opened);

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          input: text,
          ...(threadRef.current !== undefined && { threadId: threadRef.current }),
        }),
      });
      await consume(response, opened);
    } finally {
      setBusy(false);
    }
  }, [agentId, busy, consume, draft, projectId]);

  const decide = useCallback(
    async (approved: boolean): Promise<void> => {
      const awaiting = transcript?.awaiting;
      if (transcript === undefined || awaiting === undefined || busy) return;

      setBusy(true);
      const reopened = resumed(transcript);
      setTranscript(reopened);

      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(transcript.runId)}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, toolCallId: awaiting.callId, approved }),
        });
        await consume(response, reopened);
      } finally {
        setBusy(false);
      }
    },
    [busy, consume, projectId, transcript],
  );

  if (!publishable) {
    return (
      <Card className={styles.card}>
        <Title3>Playground</Title3>
        <Text as="p" className={styles.hint}>
          Publish a version first. A run resolves the published definition and answers{' '}
          <code>asset_not_published</code> rather than executing a draft nobody reviewed.
        </Text>
      </Card>
    );
  }

  return (
    <Card className={styles.card}>
      <Title3>Playground</Title3>

      {transcript !== undefined && (
        <div className={styles.transcript} aria-live="polite">
          {transcript.entries.map((entry, index) => (
            <Entry key={index} entry={entry} />
          ))}

          {busy && transcript.phase === 'running' && <Spinner size="tiny" labelPosition="after" />}

          {transcript.error !== undefined && (
            <p className={styles.error} role="alert">
              {transcript.error.message}
            </p>
          )}
        </div>
      )}

      {transcript?.awaiting !== undefined && (
        <div className={styles.approval} role="alert">
          <div className={styles.traceHead}>
            <ShieldTask20Regular />
            <Text weight="semibold">This call needs a person</Text>
            <Badge appearance="tint" color="danger">
              {transcript.awaiting.riskLevel}
            </Badge>
          </div>
          <Text as="p">
            The agent wants to run <code>{transcript.awaiting.name}</code>. It has not run.
          </Text>
          <pre className={styles.args}>{JSON.stringify(transcript.awaiting.args, null, 2)}</pre>
          <div className={styles.buttons}>
            <Button appearance="primary" disabled={busy} onClick={() => void decide(true)}>
              Approve and continue
            </Button>
            <Button disabled={busy} onClick={() => void decide(false)}>
              Refuse
            </Button>
          </div>
        </div>
      )}

      <div className={styles.composer}>
        <Textarea
          value={draft}
          placeholder="Ask the agent something"
          resize="vertical"
          disabled={busy}
          onChange={(_event, data) => {
            setDraft(data.value);
          }}
        />
        <Button
          appearance="primary"
          icon={<Play16Regular />}
          disabled={busy || draft.trim() === ''}
          onClick={() => void send()}
        >
          Run
        </Button>
      </div>
    </Card>
  );
}

function Entry({ entry }: { entry: RunEntry }): ReactElement {
  const styles = useStyles();

  if (entry.kind === 'user') return <div className={styles.user}>{entry.text}</div>;
  if (entry.kind === 'assistant') {
    return (
      <Text as="p" className={styles.assistant}>
        {entry.text}
      </Text>
    );
  }

  return (
    <div className={styles.trace}>
      <div className={styles.traceHead}>
        <Text weight="semibold">{entry.name}</Text>
        <Badge appearance="tint" color={TOOL_TONE[entry.status]}>
          {entry.status.replace('_', ' ')}
        </Badge>
      </div>
      <pre className={styles.args}>{JSON.stringify(entry.args, null, 2)}</pre>
    </div>
  );
}

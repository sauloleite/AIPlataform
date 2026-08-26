'use client';

import type { ReactElement } from 'react';
import { useCallback, useRef, useState } from 'react';

import type { ServedBy } from '../../modules/console/application/use-cases/send-chat-message';
import { readSseStream } from './read-sse-stream';

interface ProjectOption {
  id: string;
  name: string;
  localOnly: boolean;
}

interface AliasOption {
  id: string;
  dataZones: string[];
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export function Playground({
  projects,
  selectedProjectId,
  aliases,
  localOnly,
}: {
  projects: ProjectOption[];
  selectedProjectId: string;
  aliases: AliasOption[];
  localOnly: boolean;
}): ReactElement {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [alias, setAlias] = useState(aliases[0]?.id ?? '');
  const [streaming, setStreaming] = useState(false);
  const [servedBy, setServedBy] = useState<ServedBy | undefined>();
  const [error, setError] = useState<string | undefined>();

  // The history the next turn carries. Kept in a ref because `send` reads it
  // after several awaits, and reading state there would see a stale snapshot.
  const historyRef = useRef<Turn[]>([]);

  const send = useCallback(async (): Promise<void> => {
    const message = draft.trim();
    if (message === '' || alias === '' || streaming) return;

    setError(undefined);
    setServedBy(undefined);
    setDraft('');
    setStreaming(true);

    const history = historyRef.current;
    setTurns([...history, { role: 'user', content: message }, { role: 'assistant', content: '' }]);

    let answer = '';

    try {
      // No credential in this fetch: the console's own route handler reads the
      // httpOnly cookie and attaches the platform token server-side.
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProjectId,
          alias,
          message,
          history,
          maxTokens: 512,
        }),
      });

      if (!response.ok || response.body === null) {
        const problem = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(problem.detail ?? `The request failed (${response.status.toString()}).`);
      }

      for await (const update of readSseStream(response.body)) {
        if (update.kind === 'delta') {
          answer += update.content;
          setTurns([
            ...history,
            { role: 'user', content: message },
            { role: 'assistant', content: answer },
          ]);
          continue;
        }
        if (update.kind === 'finished') {
          answer = update.content !== '' ? update.content : answer;
          setServedBy(update.servedBy);
          continue;
        }
        setError(update.message);
      }

      const settled: Turn[] = [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: answer },
      ];
      historyRef.current = settled;
      setTurns(settled);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request failed.');
      // The failed turn is dropped from history: replaying a turn the model
      // never answered would poison every following prompt.
      setTurns(history);
    } finally {
      setStreaming(false);
    }
  }, [alias, draft, selectedProjectId, streaming]);

  return (
    <div className="chat">
      <section>
        <div className="transcript">
          {turns.length === 0 && <p className="empty">Send a message to start.</p>}
          {turns.map((turn, index) => (
            <div className={`turn ${turn.role}`} key={index}>
              <span className="role">{turn.role}</span>
              <span className={streaming && index === turns.length - 1 ? 'caret' : ''}>
                {turn.content}
              </span>
            </div>
          ))}
        </div>

        {error !== undefined && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor="draft">
            Message
          </label>
          <textarea
            id="draft"
            value={draft}
            placeholder="Ask something…"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line: the convention every
              // chat interface already trained people on.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" disabled={streaming || draft.trim() === '' || alias === ''}>
            {streaming ? 'Streaming…' : 'Send'}
          </button>
        </form>
      </section>

      <aside>
        <div className="card">
          <h2>Request</h2>
          <label className="field">
            <span>Project</span>
            <select
              value={selectedProjectId}
              onChange={(event) => {
                // A full navigation, not local state: the alias catalogue is
                // per project and has to be re-read from the router.
                window.location.href = `/chat?project=${event.target.value}`;
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Alias</span>
            <select
              value={alias}
              onChange={(event) => {
                setAlias(event.target.value);
              }}
            >
              {aliases.length === 0 && <option value="">no compatible alias</option>}
              {aliases.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id} — {option.dataZones.join(', ')}
                </option>
              ))}
            </select>
          </label>

          {localOnly && (
            <p className="notice">
              This project is restricted: the platform will serve it from the local model whatever
              alias you pick.
            </p>
          )}
        </div>

        {servedBy !== undefined && <ServedByPanel servedBy={servedBy} />}
      </aside>
    </div>
  );
}

/**
 * How the platform served the last answer.
 *
 * This is the point of the playground. `data_zone` is the residency evidence,
 * and `policy_stale` and `budget_unverified` are the platform telling you it
 * degraded on purpose — a degraded answer that looked identical to a healthy one
 * would teach an operator nothing.
 */
function ServedByPanel({ servedBy }: { servedBy: ServedBy }): ReactElement {
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Served by</h2>
      <dl className="pairs">
        <dt>Provider</dt>
        <dd>{servedBy.provider ?? '—'}</dd>
        <dt>Model</dt>
        <dd>{servedBy.providerModel ?? '—'}</dd>
        <dt>Data zone</dt>
        <dd>{servedBy.dataZone ?? '—'}</dd>
        <dt>Cost</dt>
        <dd>{servedBy.cost ?? '—'}</dd>
        <dt>Attempts</dt>
        <dd>{servedBy.attempts}</dd>
      </dl>

      <div className="badges">
        {servedBy.dataZone === 'local' && <span className="badge ok">never left the machine</span>}
        {servedBy.cacheHit && <span className="badge">cache hit, no provider call</span>}
        {servedBy.policyStale && <span className="badge warn">policy from cache</span>}
        {servedBy.budgetUnverified && <span className="badge warn">budget unverified</span>}
        {servedBy.attempts > 1 && (
          <span className="badge warn">failed over after {servedBy.attempts - 1}</span>
        )}
      </div>
    </div>
  );
}

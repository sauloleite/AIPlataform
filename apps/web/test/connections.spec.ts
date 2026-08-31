import { describe, expect, it } from 'vitest';

import { summarise } from '../src/modules/tools/application/use-cases/inspect-connections';
import { HttpToolsGateway } from '../src/modules/tools/infrastructure/http/tools-gateway';
import type { ConnectionSummary } from '../src/modules/tools/application/ports';

function aConnection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'c1',
    slug: 'gitlab',
    name: 'GitLab',
    kind: 'bearer',
    header: 'Authorization',
    secretRef: 'gitlab-token',
    resolved: true,
    ...overrides,
  };
}

describe('summarising connections', () => {
  it('counts the ones naming a secret this host does not have', () => {
    // The number worth putting on screen: a broken connection looks completely
    // normal until a tool fails in front of a user.
    const view = summarise([
      aConnection(),
      aConnection({ id: 'c2', slug: 'jira', resolved: false }),
      aConnection({ id: 'c3', slug: 'acme', resolved: false }),
    ]);

    expect(view.unresolved).toBe(2);
    expect(view.connections).toHaveLength(3);
  });

  it('counts none when every secret is there', () => {
    expect(summarise([aConnection()]).unresolved).toBe(0);
  });

  it('handles a project with no connections at all', () => {
    expect(summarise([])).toEqual({ connections: [], unresolved: 0 });
  });
});

describe('the connections adapter reads the contract shape', () => {
  it('maps a connection', async () => {
    const gateway = new HttpToolsGateway(
      'http://gateway',
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'c1',
                project_id: 'p1',
                slug: 'gitlab',
                name: 'GitLab',
                kind: 'bearer',
                header: 'Authorization',
                secret_ref: 'gitlab-token',
                resolved: false,
                created_at: '2026-08-29T00:00:00Z',
                updated_at: '2026-08-29T00:00:00Z',
              },
            ],
            next_cursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );

    const [connection] = await gateway.listConnections('token', 'p1');

    expect(connection?.secretRef).toBe('gitlab-token');
    // Read under the wrong key this is `undefined`, which is falsy — a broken
    // connection would render as a working one.
    expect(connection?.resolved).toBe(false);
  });

  it('sends a secret NAME and has no way to send a value', async () => {
    let sent: unknown;
    const gateway = new HttpToolsGateway('http://gateway', (async (
      _url: string,
      init?: RequestInit,
    ) => {
      sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      return new Response(
        JSON.stringify({
          id: 'c1',
          project_id: 'p1',
          slug: 'gitlab',
          name: 'GitLab',
          kind: 'bearer',
          header: 'Authorization',
          secret_ref: 'gitlab-token',
          resolved: true,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch);

    await gateway.createConnection('token', 'p1', {
      slug: 'gitlab',
      name: 'GitLab',
      kind: 'bearer',
      secretRef: 'gitlab-token',
    });

    expect(sent).toEqual({
      slug: 'gitlab',
      name: 'GitLab',
      kind: 'bearer',
      secret_ref: 'gitlab-token',
    });
    // No field carries a value, so no request can.
    expect(JSON.stringify(sent)).not.toContain('secret_value');
  });
});

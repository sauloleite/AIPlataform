import { describe, expect, it } from 'vitest';

import { AuthorizeRequest } from '../src/modules/console/application/use-cases/authorize-request';
import { CreateProject } from '../src/modules/console/application/use-cases/create-project';
import { InspectProject } from '../src/modules/console/application/use-cases/inspect-project';
import { ListProjects } from '../src/modules/console/application/use-cases/list-projects';
import { SendChatMessage } from '../src/modules/console/application/use-cases/send-chat-message';
import {
  SetBudget,
  parseAmountToMicros,
} from '../src/modules/console/application/use-cases/set-budget';
import { SignIn } from '../src/modules/console/application/use-cases/sign-in';
import { isPlatformError } from '../src/modules/console/domain/errors';
import { FakePlatform, InMemorySessionStore, aBudget, aProject, frozenClock } from './fakes';

const NOW = 1_800_000_000;

describe('SignIn', () => {
  it('stores the token in the session store and never returns it', async () => {
    const platform = new FakePlatform();
    const sessions = new InMemorySessionStore();

    const session = await new SignIn(platform, sessions, frozenClock(NOW)).execute(
      'admin@aia.local',
      'secret',
    );

    // The result carries the principal only. A token in the return value is a
    // token one careless `return` away from the browser.
    expect(session.principal.email).toBe('admin@aia.local');
    expect(JSON.stringify(session)).not.toContain('token-1');
    expect(await sessions.readToken()).toBe('token-1');
  });

  it('derives the expiry from the clock plus the token lifetime', async () => {
    const sessions = new InMemorySessionStore();
    const session = await new SignIn(new FakePlatform(), sessions, frozenClock(NOW)).execute(
      'a@b.c',
      'x',
    );

    expect(session.expiresAt).toBe(NOW + 3600);
  });

  it('propagates a refused credential instead of writing a session', async () => {
    const platform = new FakePlatform();
    platform.failing.add('signIn');
    const sessions = new InMemorySessionStore();

    await expect(
      new SignIn(platform, sessions, frozenClock(NOW)).execute('a@b.c', 'wrong'),
    ).rejects.toThrow();
    expect(await sessions.read()).toBeNull();
  });
});

describe('AuthorizeRequest', () => {
  it('refuses when there is no session', async () => {
    const sessions = new InMemorySessionStore();

    await expect(new AuthorizeRequest(sessions, frozenClock(NOW)).execute()).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('CLEARS an expired session rather than only rejecting it', async () => {
    // A dead cookie left in the browser produces a user who looks signed in and
    // collects 401s.
    const sessions = new InMemorySessionStore();
    await sessions.write(
      { principal: { id: 'u', type: 'user', globalRoles: [], memberships: [] }, expiresAt: NOW },
      'token-1',
    );

    await expect(new AuthorizeRequest(sessions, frozenClock(NOW)).execute()).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(sessions.cleared).toBe(1);
  });

  it('returns the session and the token while it is valid', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.write(
      {
        principal: { id: 'u', type: 'user', globalRoles: [], memberships: [] },
        expiresAt: NOW + 1,
      },
      'token-1',
    );

    const { accessToken } = await new AuthorizeRequest(sessions, frozenClock(NOW)).execute();
    expect(accessToken).toBe('token-1');
  });
});

describe('ListProjects', () => {
  it('marks a restricted project as local only', async () => {
    const platform = new FakePlatform();
    platform.projects = [aProject({ id: 'p1', dataClassification: 'restricted' })];
    platform.budgets.set('p1', aBudget({ projectId: 'p1' }));

    const [card] = await new ListProjects(platform).execute('token');

    expect(card?.localOnly).toBe(true);
    expect(card?.budget?.ratio).toBeCloseTo(0.2);
    expect(card?.budget?.limit).toBe('BRL 50.00');
  });

  it('still lists a project whose budget cannot be read', async () => {
    // Governance being degraded must not blank the whole page.
    const platform = new FakePlatform();
    platform.projects = [aProject({ id: 'p1' })];
    platform.failing.add('getBudget:p1');

    const [card] = await new ListProjects(platform).execute('token');

    expect(card?.name).toBe('Sample project');
    expect(card?.budget).toBeUndefined();
  });
});

describe('CreateProject', () => {
  const platform = (): FakePlatform => new FakePlatform();
  const valid = {
    slug: 'my-project',
    name: 'My project',
    dataClassification: 'internal',
    legalBasis: 'legitimate interest',
    purpose: 'support assistant',
  };

  it('creates a project when everything is filled in', async () => {
    const fake = platform();
    const project = await new CreateProject(fake).execute('token', valid);

    expect(project.slug).toBe('my-project');
    expect(fake.calls).toContain('createProject:my-project');
  });

  it('refuses without a legal basis, which LGPD art. 7 requires', async () => {
    const fake = platform();

    await expect(
      new CreateProject(fake).execute('token', { ...valid, legalBasis: '  ' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // Nothing reached the platform: the refusal happened before the call.
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an unknown classification instead of letting the server guess', async () => {
    await expect(
      new CreateProject(platform()).execute('token', {
        ...valid,
        dataClassification: 'secreto',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('reports every problem at once rather than one per round trip', async () => {
    try {
      await new CreateProject(platform()).execute('token', {
        slug: 'BAD SLUG',
        name: 'x',
        dataClassification: 'nope',
        legalBasis: '',
        purpose: '',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isPlatformError(error)).toBe(true);
      if (isPlatformError(error)) {
        expect(error.problem['issues']).toHaveLength(5);
      }
    }
  });

  it('drops an empty description instead of sending a blank string', async () => {
    const fake = platform();
    const project = await new CreateProject(fake).execute('token', { ...valid, description: '  ' });
    expect(project.description).toBeUndefined();
  });
});

describe('SetBudget', () => {
  it('parses a typed amount straight into micros, with no float in between', () => {
    expect(parseAmountToMicros('50')).toBe(50_000_000n);
    expect(parseAmountToMicros('50.75')).toBe(50_750_000n);
    expect(parseAmountToMicros('0.1')).toBe(100_000n);
    expect(parseAmountToMicros('0,25')).toBe(250_000n);
    expect(parseAmountToMicros(' 12.000001 ')).toBe(12_000_001n);
  });

  it('refuses more precision than micros can hold, rather than truncating it', () => {
    // Silently dropping a digit from a budget is the kind of bug nobody notices
    // until the invoice arrives.
    expect(() => parseAmountToMicros('1.0000001')).toThrow(/not a valid amount/);
    expect(() => parseAmountToMicros('abc')).toThrow(/not a valid amount/);
    expect(() => parseAmountToMicros('-5')).toThrow(/not a valid amount/);
  });

  it('sends micros as a string so a large budget survives JSON', async () => {
    const platform = new FakePlatform();
    await new SetBudget(platform).execute('token', 'p1', {
      amount: '9007199254.740993',
      currency: 'brl',
      period: 'monthly',
      blockAtLimit: true,
    });

    expect(platform.calls).toContain('setBudget:p1:9007199254740993');
  });
});

describe('InspectProject', () => {
  it('shows the zones the policy narrowed away from the classification', async () => {
    const platform = new FakePlatform();
    platform.projects = [aProject({ id: 'p1', dataClassification: 'internal' })];
    platform.policies.set('p1', {
      projectId: 'p1',
      dataClassification: 'internal',
      allowedDataZones: ['local', 'br'],
      maxConcurrentRequests: 20,
      contentCapture: false,
      version: 3,
    });

    const detail = await new InspectProject(platform).execute('token', 'p1');

    // internal permits every zone; the policy switched three of them off.
    expect(detail.narrowedZones).toEqual(['us', 'eu', 'global']);
  });

  it('renders what it could read when governance is degraded', async () => {
    const platform = new FakePlatform();
    platform.projects = [aProject({ id: 'p1' })];
    platform.failing.add('getBudget:p1');
    platform.failing.add('getPolicy:p1');

    const detail = await new InspectProject(platform).execute('token', 'p1');

    expect(detail.name).toBe('Sample project');
    expect(detail.budget).toBeUndefined();
    expect(detail.policy).toBeUndefined();
  });

  it('exposes the limit as a plain amount the form can round-trip', async () => {
    const platform = new FakePlatform();
    platform.projects = [aProject({ id: 'p1' })];
    platform.budgets.set('p1', aBudget({ projectId: 'p1' }));

    const detail = await new InspectProject(platform).execute('token', 'p1');

    expect(detail.budget?.limitAmount).toBe('50.00');
    expect(detail.budget?.remaining).toBe('BRL 40.00');
  });

  it('fails when the project itself does not exist', async () => {
    await expect(
      new InspectProject(new FakePlatform()).execute('token', 'missing'),
    ).rejects.toMatchObject({ code: 'project_not_found' });
  });
});

describe('SendChatMessage', () => {
  it('assembles the deltas and reports how the answer was served', async () => {
    const platform = new FakePlatform();
    platform.streamEvents = [
      { kind: 'delta', content: 'he' },
      { kind: 'delta', content: 'llo' },
      {
        kind: 'finished',
        content: '',
        routing: {
          provider: 'ollama',
          dataZone: 'local',
          cost: { currency: 'BRL', micros: '0' },
          attempts: 1,
        },
      },
    ];

    const updates = await collect(
      new SendChatMessage(platform).execute('token', {
        projectId: 'p1',
        alias: 'chat-local',
        history: [],
        message: 'hi',
      }),
    );

    const finished = updates.at(-1);
    expect(finished).toMatchObject({ kind: 'finished', content: 'hello' });
    if (finished?.kind === 'finished') {
      expect(finished.servedBy.dataZone).toBe('local');
      expect(finished.servedBy.cost).toBe('BRL 0.00');
      expect(finished.servedBy.cacheHit).toBe(false);
    }
  });

  it('handles a cache hit, which arrives whole with no deltas at all', async () => {
    const platform = new FakePlatform();
    platform.streamEvents = [
      {
        kind: 'finished',
        content: 'from cache',
        routing: { cacheHit: true, dataZone: 'local' },
      },
    ];

    const updates = await collect(
      new SendChatMessage(platform).execute('token', {
        projectId: 'p1',
        alias: 'chat-local',
        history: [],
        message: 'hi',
      }),
    );

    expect(updates.at(-1)).toMatchObject({ kind: 'finished', content: 'from cache' });
  });

  it('surfaces a degraded answer instead of letting it look healthy', async () => {
    const platform = new FakePlatform();
    platform.streamEvents = [
      {
        kind: 'finished',
        content: 'ok',
        routing: { policyStale: true, budgetUnverified: true, attempts: 3 },
      },
    ];

    const updates = await collect(
      new SendChatMessage(platform).execute('token', {
        projectId: 'p1',
        alias: 'chat-fast',
        history: [],
        message: 'hi',
      }),
    );

    const finished = updates.at(-1);
    if (finished?.kind !== 'finished') expect.unreachable('expected a finished update');
    else {
      expect(finished.servedBy.policyStale).toBe(true);
      expect(finished.servedBy.budgetUnverified).toBe(true);
      expect(finished.servedBy.attempts).toBe(3);
    }
  });

  it('passes an error through with its stable code', async () => {
    const platform = new FakePlatform();
    platform.streamEvents = [
      { kind: 'error', code: 'budget_exhausted', message: 'Budget exhausted' },
    ];

    const updates = await collect(
      new SendChatMessage(platform).execute('token', {
        projectId: 'p1',
        alias: 'chat-fast',
        history: [],
        message: 'hi',
      }),
    );

    expect(updates.at(-1)).toMatchObject({ kind: 'error', code: 'budget_exhausted' });
  });

  it('sends the history plus the new turn', async () => {
    const platform = new FakePlatform();
    platform.streamEvents = [{ kind: 'finished', content: 'ok', routing: {} }];

    await collect(
      new SendChatMessage(platform).execute('token', {
        projectId: 'p1',
        alias: 'chat-local',
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
        ],
        message: 'second',
      }),
    );

    expect(platform.calls).toContain('streamChat:chat-local:3');
  });
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

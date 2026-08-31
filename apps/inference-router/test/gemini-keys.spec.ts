import { describe, expect, it } from 'vitest';

import { geminiKeys, loadConfig, type GeminiKeyConfig } from '../src/config/index.js';
import { GeminiProvider } from '../src/modules/completions/infrastructure/providers/gemini.provider.js';
import { aDeployment } from './builders.js';

/**
 * Several Gemini keys, used in turn.
 *
 * A quota is per key, so three of them triple the ceiling — and because the
 * cursor advances on every outbound call, the retry `POLICIES.INFERENCE`
 * already performs after a 429 lands on the next key. Failover for free.
 */

/** The few variables the schema genuinely requires, and nothing else. */
const MINIMAL_ENV = {
  MONGO_URI: 'mongodb://localhost:27017',
  REDIS_URL: 'redis://localhost:6379',
  IDENTITY_ISSUER: 'http://identity:3001',
  GOVERNANCE_URL: 'http://governance:3002',
};

function config(overrides: Partial<GeminiKeyConfig> = {}): GeminiKeyConfig {
  return {
    GEMINI_API_KEY: '',
    GEMINI_API_KEYS: '',
    GEMINI_API_KEY_1: '',
    GEMINI_API_KEY_2: '',
    GEMINI_API_KEY_3: '',
    ...overrides,
  };
}

function provider(apiKeys: string[]): GeminiProvider {
  return new GeminiProvider({
    apiKeys,
    baseUrl: 'https://gemini.test',
    apiVersion: 'v1beta',
    protocol: 'generate-content',
  });
}

async function keysUsedBy(instance: GeminiProvider, calls: number): Promise<string[]> {
  const seen: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push(headers['x-goog-api-key'] ?? '');
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as unknown as typeof globalThis.fetch;

  const request = { messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 16 };
  const deployment = aDeployment({ id: 'gemini-flash', provider: 'gemini', dataZone: 'global' });

  try {
    for (let index = 0; index < calls; index += 1) {
      await instance.chat(request, deployment, new AbortController().signal);
    }
    return seen;
  } finally {
    globalThis.fetch = original;
  }
}

describe('geminiKeys', () => {
  it('reads the numbered slots, in order', () => {
    expect(
      geminiKeys(
        config({ GEMINI_API_KEY_1: 'one', GEMINI_API_KEY_2: 'two', GEMINI_API_KEY_3: 'three' }),
      ),
    ).toEqual(['one', 'two', 'three']);
  });

  it('skips a slot left empty rather than shifting the rest', () => {
    // Slot 2 empty and slot 3 filled is somebody midway through pasting. It
    // should use what is there, not refuse and not rotate into a blank.
    expect(geminiKeys(config({ GEMINI_API_KEY_1: 'one', GEMINI_API_KEY_3: 'three' }))).toEqual([
      'one',
      'three',
    ]);
  });

  it('reads a comma-separated list for more than three', () => {
    expect(geminiKeys(config({ GEMINI_API_KEYS: 'four,five' }))).toEqual(['four', 'five']);
  });

  it('trims whitespace, because a .env is written by a person', () => {
    expect(geminiKeys(config({ GEMINI_API_KEYS: ' one , two ' }))).toEqual(['one', 'two']);
  });

  it('drops a blank left by a trailing comma', () => {
    // An empty key would rotate into a guaranteed 401 every Nth request.
    expect(geminiKeys(config({ GEMINI_API_KEYS: 'one,,two,' }))).toEqual(['one', 'two']);
  });

  it('still accepts the bare singular, so an old .env keeps working', () => {
    expect(geminiKeys(config({ GEMINI_API_KEY: 'legacy' }))).toEqual(['legacy']);
  });

  it('uses every form together rather than letting one win', () => {
    // Somebody who fills a slot and leaves an old key in place meant to use
    // both. Ignoring one is what nobody notices until a quota runs out early.
    expect(
      geminiKeys(
        config({ GEMINI_API_KEY_1: 'slot', GEMINI_API_KEYS: 'listed', GEMINI_API_KEY: 'legacy' }),
      ),
    ).toEqual(['slot', 'listed', 'legacy']);
  });

  it('uses the same key once, however many places it was pasted into', () => {
    // The same key twice does not double a quota. It halves the worth of the
    // rotation while looking like it doubled it.
    expect(
      geminiKeys(
        config({ GEMINI_API_KEY_1: 'same', GEMINI_API_KEY_2: 'same', GEMINI_API_KEY: 'same' }),
      ),
    ).toEqual(['same']);
  });

  it('answers nothing when no key is configured', () => {
    // A missing provider key disables that provider; it does not bring the
    // service down.
    expect(geminiKeys(config())).toEqual([]);
  });
});

describe('the provider rotates its keys', () => {
  it('is not configured with no key at all', () => {
    expect(provider([]).configured).toBe(false);
    expect(provider(['']).configured).toBe(false);
  });

  it('is configured with one', () => {
    expect(provider(['only']).configured).toBe(true);
  });

  it('cycles through three, and wraps', async () => {
    const used = await keysUsedBy(provider(['key-a', 'key-b', 'key-c']), 7);

    expect(used).toEqual(['key-a', 'key-b', 'key-c', 'key-a', 'key-b', 'key-c', 'key-a']);
  });

  it('uses the single key every time when there is only one', async () => {
    const used = await keysUsedBy(provider(['only']), 3);

    expect(used).toEqual(['only', 'only', 'only']);
  });

  it('never sends the key in the URL', async () => {
    // A query string ends up in proxy logs and in browser history; a header
    // does not.
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    try {
      await provider(['secret-key']).chat(
        { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16 },
        aDeployment({ id: 'gemini-flash', provider: 'gemini', dataZone: 'global' }),
        new AbortController().signal,
      );
    } finally {
      globalThis.fetch = original;
    }

    expect(seen[0]).not.toContain('secret-key');
  });
});

describe('turning a provider off', () => {
  it('accepts an empty OLLAMA_BASE_URL, which disables Ollama', () => {
    // "A missing provider key disables that provider; it does not bring the
    // service down." Ollama's key IS its URL, and a plain `.url()` made it the
    // one provider nobody could turn off.
    const config = loadConfig({
      ...MINIMAL_ENV,
      OLLAMA_BASE_URL: '',
    });

    expect(config.OLLAMA_BASE_URL).toBe('');
  });

  it('still refuses something that is not a URL at all', () => {
    // Disabling is an empty string, not "anything goes": a typo should fail at
    // boot, not at the first request.
    expect(() => loadConfig({ ...MINIMAL_ENV, OLLAMA_BASE_URL: 'not a url' })).toThrow();
  });

  it('defaults to the containerised Ollama when nothing is said', () => {
    expect(loadConfig(MINIMAL_ENV).OLLAMA_BASE_URL).toBe('http://ollama:11434');
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ToolInvocation } from '../src/modules/tools/application/ports.js';
import {
  InvalidToolArgumentsError,
  ToolExecutionFailedError,
} from '../src/modules/tools/domain/errors/index.js';
import {
  BUILTIN_TOOLS,
  builtinToolId,
} from '../src/modules/tools/domain/value-objects/builtin-tools.js';
import {
  MAX_TEXT_CHARACTERS,
  WebFetchExecutor,
  isReadableContentType,
} from '../src/modules/tools/infrastructure/executors/web-fetch-executor.js';
import { PublicWebClient } from '../src/modules/tools/infrastructure/web/public-web-client.js';
import { readableText } from '../src/modules/tools/infrastructure/web/readable-text.js';

/**
 * The web-fetch built-in, against a real HTTP server.
 *
 * The server listens on loopback, which the real address rule refuses, so the
 * happy-path tests give the client a resolver that answers a public-looking
 * name with 127.0.0.1 and an address rule that lets loopback through. The
 * refusal tests keep the REAL rule and change only what DNS answers -- which is
 * exactly the attacker's lever.
 */

const WEB_FETCH = BUILTIN_TOOLS.find((tool) => tool.toolId === builtinToolId('web_fetch'))!;
const PAGE_HOST = 'pages.example.test';

let server: Server;
let port = 0;
let requests = 0;

const ROUTES: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
  '/article': (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<html><head><title>Rio &amp; S&atilde;o Paulo</title><style>body{}</style></head>' +
        '<body><nav>Home | About</nav><h1>Two cities</h1><script>steal()</script>' +
        '<p>Rio has beaches &mdash; S&#227;o Paulo has &#x1F355;.</p><ul><li>One</li><li>Two</li></ul>' +
        '<footer>Copyright</footer></body></html>',
    );
  },
  '/gzipped': (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
    response.end(gzipSync('compressed text'));
  },
  '/huge': (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('a'.repeat(MAX_TEXT_CHARACTERS * 3));
  },
  '/bomb': (_request, response) => {
    // A few kilobytes that inflate to megabytes: the limit must count what
    // comes OUT of the decoder.
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
    response.end(gzipSync(Buffer.alloc(8 * 1024 * 1024, 'x')));
  },
  '/pdf': (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end('%PDF-1.7');
  },
  '/missing': (_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/html' });
    response.end('<h1>Not found</h1>');
  },
  '/to-article': (_request, response) => {
    response.writeHead(302, { Location: '/article' });
    response.end();
  },
  '/to-internal': (_request, response) => {
    response.writeHead(302, { Location: 'http://registry:3004/v1/assets' });
    response.end();
  },
  '/to-metadata': (_request, response) => {
    response.writeHead(301, { Location: 'http://169.254.169.254/latest/meta-data/' });
    response.end();
  },
  '/loop': (_request, response) => {
    response.writeHead(302, { Location: '/loop' });
    response.end();
  },
};

beforeAll(async () => {
  server = createServer((request, response) => {
    requests += 1;
    const route = ROUTES[new URL(request.url ?? '/', 'http://x').pathname];
    if (route === undefined) {
      response.writeHead(500);
      response.end();
      return;
    }
    route(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function client(
  overrides: Partial<ConstructorParameters<typeof PublicWebClient>[0]> = {},
): PublicWebClient {
  return new PublicWebClient({
    maxBytes: 1024 * 1024,
    maxRedirects: 3,
    userAgent: 'test',
    isReadable: isReadableContentType,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isAllowedAddress: () => true,
    ...overrides,
  });
}

function fetchPage(path: string, webClient = client()) {
  const invocation: ToolInvocation = {
    tool: WEB_FETCH,
    arguments: { url: `http://${PAGE_HOST}:${port.toString()}${path}` },
    accessToken: 'caller-token',
    projectId: 'p1',
    principalId: 'user-ana',
  };
  return new WebFetchExecutor(webClient).execute(invocation);
}

function fetchUrl(url: unknown, webClient = client()) {
  return new WebFetchExecutor(webClient).execute({
    tool: WEB_FETCH,
    arguments: { url },
    accessToken: 'caller-token',
    projectId: 'p1',
    principalId: 'user-ana',
  });
}

describe('reading a page', () => {
  it('returns the title and the prose, without scripts, styles or page chrome', async () => {
    const { result } = await fetchPage('/article');

    expect(result).toMatchObject({
      status: 200,
      content_type: 'text/html',
      title: 'Rio & São Paulo',
      truncated: false,
    });
    const text = (result as { text: string }).text;
    expect(text).toContain('Two cities');
    expect(text).toContain('Rio has beaches — São Paulo has 🍕.');
    expect(text).toContain('- One');
    expect(text).not.toContain('steal()');
    expect(text).not.toContain('Home | About');
    expect(text).not.toContain('Copyright');
  });

  it('follows a redirect and reports where the page really was', async () => {
    const { result } = await fetchPage('/to-article');

    expect((result as { url: string }).url).toMatch(/\/article$/);
  });

  it('decodes a compressed page', async () => {
    const { result } = await fetchPage('/gzipped');

    expect((result as { text: string }).text).toBe('compressed text');
  });

  it('cuts a long page and says it did', async () => {
    const { result } = await fetchPage('/huge');

    expect((result as { text: string }).text).toHaveLength(MAX_TEXT_CHARACTERS);
    expect((result as { truncated: boolean }).truncated).toBe(true);
  });

  it('stops reading at the byte limit, counted after decompression', async () => {
    const small = client({ maxBytes: 64 * 1024 });

    const { result } = await fetchPage('/bomb', small);

    expect((result as { text: string }).text.length).toBeLessThanOrEqual(64 * 1024);
    expect((result as { truncated: boolean }).truncated).toBe(true);
  });
});

describe('what the model is told when a page cannot be read', () => {
  it('reports a 404 as a failure naming the status', async () => {
    await expect(fetchPage('/missing')).rejects.toThrow(ToolExecutionFailedError);
    await expect(fetchPage('/missing')).rejects.toThrow('404');
  });

  it('refuses a binary document rather than handing bytes to a model', async () => {
    await expect(fetchPage('/pdf')).rejects.toThrow(/application\/pdf/);
  });

  it('gives up on a redirect loop, as a page that cannot be read rather than a bad argument', async () => {
    await expect(fetchPage('/loop')).rejects.toThrow(ToolExecutionFailedError);
    await expect(fetchPage('/loop')).rejects.toThrow(/redirected more than 3 times/);
  });

  it.each([
    ['no url at all', undefined],
    ['a url that is not a string', { href: 'http://example.com' }],
    ['something that is not a URL', 'not a url'],
  ])('refuses %s as a bad argument', async (_case, url) => {
    await expect(fetchUrl(url)).rejects.toThrow(InvalidToolArgumentsError);
  });

  it('says so when the operator switched web-fetch off', async () => {
    const off = new WebFetchExecutor(
      client(),
      'Reading web pages is switched off on this platform',
    );

    expect(await off.unavailableReason()).toContain('switched off');
  });
});

describe('SSRF: the platform’s own network is never what gets read', () => {
  // The REAL address rule from here on. Only DNS is under the test's control.
  const resolvingTo = (...addresses: string[]): PublicWebClient =>
    client({
      resolve: async () =>
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      isAllowedAddress: undefined,
    });

  it.each([
    ['a Docker network address', '172.18.0.4'],
    ['cloud metadata', '169.254.169.254'],
    ['loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
  ])('refuses a public-looking name that resolves to %s', async (_case, address) => {
    const before = requests;

    await expect(fetchPage('/article', resolvingTo(address))).rejects.toThrow(
      InvalidToolArgumentsError,
    );
    // Refused at connection time: the request never reached the server.
    expect(requests).toBe(before);
  });

  it('refuses a name that answers with a public AND a private address', async () => {
    await expect(fetchPage('/article', resolvingTo('93.184.216.34', '10.0.0.7'))).rejects.toThrow(
      InvalidToolArgumentsError,
    );
  });

  it.each([
    ['a container name', 'http://registry:3004/v1/assets'],
    ['a loopback literal', 'http://127.0.0.1:27017/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost', 'http://localhost:3006/'],
    ['a file', 'file:///etc/passwd'],
  ])('refuses %s before any lookup', async (_case, url) => {
    let looked = false;
    const watching = client({
      resolve: async () => {
        looked = true;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });

    await expect(fetchUrl(url, watching)).rejects.toThrow(InvalidToolArgumentsError);
    expect(looked).toBe(false);
  });

  it.each([
    ['a container name', '/to-internal'],
    ['cloud metadata', '/to-metadata'],
  ])('refuses a public page that redirects to %s', async (_case, path) => {
    // The public hop is allowed by the resolver; the redirect target is judged
    // on its own, by the real rule.
    await expect(fetchPage(path)).rejects.toThrow(InvalidToolArgumentsError);
  });
});

describe('readableText', () => {
  it('decodes the accented letters an older Portuguese page is written in, respecting case', () => {
    expect(readableText('<p>Informa&ccedil;&atilde;o &Agrave; &agrave; &frac12;</p>').text).toBe(
      'Informação À à ½',
    );
  });

  it('leaves an unknown entity as it was rather than guessing', () => {
    expect(readableText('<p>&notanentity; &#xD800;</p>').text).toBe('&notanentity; &#xD800;');
  });

  it('keeps a header element, which is content, while dropping head', () => {
    expect(readableText('<head><title>T</title></head><header>Masthead</header>').text).toBe(
      'Masthead',
    );
  });

  it('has no title when the page has none', () => {
    expect(readableText('<p>Just text</p>')).toEqual({ text: 'Just text' });
  });
});

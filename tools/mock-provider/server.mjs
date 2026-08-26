#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible model server, for CI only.
 *
 * Why this exists: the end-to-end suite must verify the PLATFORM — routing by
 * data classification, budget reserve and commit, SSE framing, audit records —
 * not the throughput of whatever machine runs it. A real model makes that suite
 * slow and flaky: on a GitHub runner without a GPU, a local model takes minutes
 * per call and times out.
 *
 * This server speaks the same wire protocol the real providers do, so the
 * production `OpenAiProvider` adapter is exercised end to end. What changes is
 * only that responses are instant and identical every run.
 *
 * It is never part of a production image. The compose file wires it in through
 * an override used exclusively by CI.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8090);

/** Deterministic reply. Token counts are stable so budget assertions can be exact. */
const REPLY = 'ok';
const PROMPT_TOKENS = 10;
const COMPLETION_TOKENS = 1;

function usage() {
  return {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Streams the reply as newline-delimited JSON, matching Ollama's framing:
 * one object per delta, the last carrying `done: true` and the token counts.
 */
function streamNdjson(response, model) {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache, no-transform',
  });

  const line = (payload) => `${JSON.stringify(payload)}\n`;

  response.write(
    line({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: REPLY },
      done: false,
    }),
  );
  response.write(
    line({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: PROMPT_TOKENS,
      eval_count: COMPLETION_TOKENS,
    }),
  );
  response.end();
}

/**
 * Streams the reply as Server-Sent Events, matching OpenAI's framing:
 * one `chat.completion.chunk` per delta, a final chunk carrying `usage`
 * (because the router asks for `stream_options.include_usage`), then `[DONE]`.
 */
function streamCompletion(response, model) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const id = `chatcmpl-mock-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  const chunk = (choice, extra = {}) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [choice],
      ...extra,
    })}\n\n`;

  response.write(
    chunk({ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }),
  );
  response.write(chunk({ index: 0, delta: {}, finish_reason: 'stop' }, { usage: usage() }));
  response.write('data: [DONE]\n\n');
  response.end();
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  // Ollama's model listing, used by the router's readiness probe.
  if (request.method === 'GET' && pathname === '/api/tags') {
    sendJson(response, 200, { models: [{ name: 'mock-chat', model: 'mock-chat' }] });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: { message: 'method not allowed' } });
    return;
  }

  void readBody(request)
    .then((body) => {
      const model = typeof body.model === 'string' ? body.model : 'mock-model';

      if (pathname === '/v1/chat/completions') {
        if (body.stream === true) {
          streamCompletion(response, model);
          return;
        }
        sendJson(response, 200, {
          id: `chatcmpl-mock-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: REPLY },
              finish_reason: 'stop',
            },
          ],
          usage: usage(),
        });
        return;
      }

      // ── Ollama protocol ────────────────────────────────────────────────
      // Serving both wire formats means the real OllamaProvider adapter is
      // under test too, and no extra configuration knob has to exist in
      // production code just to make CI work.
      if (pathname === '/api/chat') {
        if (body.stream === true) {
          streamNdjson(response, model);
          return;
        }
        sendJson(response, 200, {
          model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: REPLY },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: PROMPT_TOKENS,
          eval_count: COMPLETION_TOKENS,
        });
        return;
      }

      if (pathname === '/api/embed') {
        const ollamaInput = Array.isArray(body.input) ? body.input : [body.input ?? ''];
        sendJson(response, 200, {
          model,
          embeddings: ollamaInput.map(() => [0.1, 0.2, 0.3]),
          prompt_eval_count: PROMPT_TOKENS,
        });
        return;
      }

      // ── OpenAI protocol ───────────────────────────────────────────────
      if (pathname === '/v1/embeddings') {
        const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
        sendJson(response, 200, {
          object: 'list',
          model,
          data: input.map((_, index) => ({
            object: 'embedding',
            index,
            // Fixed vector: assertions on similarity stay reproducible.
            embedding: [0.1, 0.2, 0.3],
          })),
          usage: { prompt_tokens: PROMPT_TOKENS, total_tokens: PROMPT_TOKENS },
        });
        return;
      }

      sendJson(response, 404, { error: { message: `unknown path ${pathname}` } });
    })
    .catch(() => {
      sendJson(response, 400, { error: { message: 'invalid JSON body' } });
    });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock model provider listening on ${String(PORT)}`);
});

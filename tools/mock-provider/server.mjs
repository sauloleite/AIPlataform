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

/**
 * The one tool call this server ever makes.
 *
 * Without it the agent half of flow 7.2 -- a run that stops at
 * `waiting_approval` until a person decides -- cannot be tested anywhere: a
 * real model chooses whether to call a tool, so the assertion would pass or
 * skip depending on the weather. Here it is a decision, not a hope.
 *
 * The rule is deliberately narrow. A tool is called when the request declares
 * tools AND no tool result is already in the conversation, so the loop runs
 * exactly once and then answers: one call, one approval, one reply. Without
 * the second half the agent would call the same tool until the step limit.
 */
function toolCallFor(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) return undefined;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.some((message) => message?.role === 'tool')) return undefined;

  const first = tools[0]?.function ?? tools[0];
  const name = typeof first?.name === 'string' ? first.name : '';
  return name === '' ? undefined : { name, args: argumentsFor(first?.parameters) };
}

/**
 * Arguments built from the declared schema's required fields, typed as the
 * schema asks, so the call satisfies the gateway's validation (ADR-025)
 * instead of being refused before it can ever reach an approval.
 *
 * Nothing here has to know what a `store_id` is: for `file_search` the schema
 * the model receives asks only for a query, and aia-agent-runtime binds the
 * store from the AGENT's attachment rather than from anything the model says.
 */
const PLACEHOLDER = { string: 'mock', number: 1, integer: 1, boolean: true };

function argumentsFor(schema) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const properties = schema?.properties ?? {};
  return Object.fromEntries(
    required.map((field) => [field, PLACEHOLDER[properties[field]?.type] ?? 'mock']),
  );
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
function streamNdjson(response, model, call) {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache, no-transform',
  });

  const line = (payload) => `${JSON.stringify(payload)}\n`;

  response.write(
    line({
      model,
      created_at: new Date().toISOString(),
      message:
        call === undefined
          ? { role: 'assistant', content: REPLY }
          : {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: call.name, arguments: call.args } }],
            },
      done: false,
    }),
  );
  response.write(
    line({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: call === undefined ? 'stop' : 'tool_calls',
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
function streamCompletion(response, model, call) {
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
    chunk({
      index: 0,
      delta:
        call === undefined
          ? { role: 'assistant', content: REPLY }
          : {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_mock_0',
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            },
      finish_reason: null,
    }),
  );
  response.write(
    chunk(
      { index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' },
      { usage: usage() },
    ),
  );
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
          streamCompletion(response, model, toolCallFor(body));
          return;
        }
        const call = toolCallFor(body);
        sendJson(response, 200, {
          id: `chatcmpl-mock-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            call === undefined
              ? { index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }
              : {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'call_mock_0',
                        type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.args) },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
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
          streamNdjson(response, model, toolCallFor(body));
          return;
        }
        const ollamaCall = toolCallFor(body);
        sendJson(response, 200, {
          model,
          created_at: new Date().toISOString(),
          message:
            ollamaCall === undefined
              ? { role: 'assistant', content: REPLY }
              : {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{ function: { name: ollamaCall.name, arguments: ollamaCall.args } }],
                },
          done: true,
          done_reason: ollamaCall === undefined ? 'stop' : 'tool_calls',
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

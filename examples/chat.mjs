#!/usr/bin/env node
/**
 * The TypeScript SDK against a local platform.
 *
 * No API key: `chat-local` runs on the machine. That is the promise this file
 * exists to check.
 */
import { AiaClient, PlatformError } from '@aia/sdk';

const BASE_URL = process.env.PLATFORM_BASE_URL ?? 'http://localhost:8080';
const EMAIL = process.env.IDENTITY_BOOTSTRAP_ADMIN_EMAIL ?? 'admin@aia.local';
const PASSWORD = process.env.IDENTITY_BOOTSTRAP_ADMIN_PASSWORD ?? 'change-me-now';
const PROJECT_SLUG = process.env.AIA_PROJECT_SLUG ?? 'sample';

/**
 * Signing in is not the SDK's job, and that is a decision rather than a gap:
 * how a program gets a token is its own business -- a password here, a personal
 * access token in a script, client credentials in a service.
 */
async function signIn() {
  const response = await fetch(`${BASE_URL}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'password', username: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`Could not sign in (${response.status}). Is the platform up? Try: make dev`);
  }
  return (await response.json()).access_token;
}

async function projectId(token) {
  const response = await fetch(`${BASE_URL}/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { items } = await response.json();
  const project = items.find((candidate) => candidate.slug === PROJECT_SLUG);
  if (project === undefined) {
    throw new Error(`No project "${PROJECT_SLUG}". Run: make seed`);
  }
  return project.id;
}

const token = await signIn();
const aia = new AiaClient({ baseUrl: BASE_URL, projectId: await projectId(token), token });

const aliases = await aia.models();
console.log('Aliases this project may use:');
for (const alias of aliases) {
  console.log(`  ${alias.id.padEnd(16)} zones: ${(alias.data_zones ?? []).join(', ')}`);
}

try {
  const answer = await aia.chat({
    model: 'chat-local',
    messages: [{ role: 'user', content: 'Answer in one word: is this platform running?' }],
    max_tokens: 16,
  });
  console.log(`\n${answer.choices[0].message.content}`);
  // The routing metadata is the point of a governed gateway: which deployment
  // served it, in which zone, at what cost.
  const routing = answer.aia;
  console.log(
    `  served by ${routing.provider} in zone ${routing.data_zone}, ` +
      `${routing.cost.micros} micros, ${answer.usage.total_tokens} tokens`,
  );

  process.stdout.write('\nstreaming: ');
  for await (const event of aia.chatStream({
    model: 'chat-local',
    messages: [{ role: 'user', content: 'Count to three.' }],
    max_tokens: 32,
  })) {
    if (event.kind === 'delta') process.stdout.write(event.content);
    if (event.kind === 'error') process.stdout.write(`\n  the stream failed: ${event.code}`);
  }
  process.stdout.write('\n');
} catch (error) {
  if (error instanceof PlatformError) {
    // The stable code is what a caller branches on, and the trace id is what
    // makes a bug report findable.
    console.error(`\nRefused: ${error.code} (${error.status}) -- ${error.message}`);
    if (error.traceId !== undefined) console.error(`  trace: ${error.traceId}`);
    process.exit(1);
  }
  throw error;
}

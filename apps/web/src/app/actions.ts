'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { getContainer } from '../container';
import { messageFor, messageForSignIn } from '../modules/console/domain/errors';
import type { ConnectionKind } from '../modules/tools/application/ports';

/**
 * Server Actions: the console's write path.
 *
 * A form posts straight to the server, so the access token stays in the httpOnly
 * cookie and never has to be handed to a client component. The alternative —
 * route handlers called by `fetch` from the browser — would need the same token
 * anyway and add a hop for nothing. Streaming is the one case that still needs a
 * route handler, because an action cannot stream.
 *
 * Every action returns a message instead of throwing: a thrown error in an
 * action becomes a generic error boundary, and "budget_exhausted" is worth more
 * to the user than "something went wrong".
 */
export interface ActionResult {
  error?: string;
}

/**
 * Reads a text field from a form.
 *
 * `FormData.get` returns `string | File`, and `String(file)` yields
 * "[object File]" — a value that would sail through validation and land in the
 * database. Anything that is not a string is treated as absent.
 */
function text(form: FormData, field: string, fallback = ''): string {
  const value = form.get(field);
  return typeof value === 'string' ? value : fallback;
}

export async function signInAction(_previous: ActionResult, form: FormData): Promise<ActionResult> {
  const username = text(form, 'username');
  const password = text(form, 'password');

  if (username === '' || password === '') {
    return { error: 'Enter your email and password.' };
  }

  const { signIn } = await getContainer();

  try {
    await signIn.execute(username, password);
  } catch (error) {
    return { error: messageForSignIn(error) };
  }

  // Outside the try: `redirect` works by throwing, and catching it here would
  // turn a successful sign-in into an error message.
  redirect('/');
}

export async function signOutAction(): Promise<void> {
  const { sessions } = await getContainer();
  await sessions.clear();
  redirect('/login');
}

export async function createProjectAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { authorize, createProject } = await getContainer();

  let projectId: string;
  try {
    const { accessToken } = await authorize.execute();
    const project = await createProject.execute(accessToken, {
      slug: text(form, 'slug'),
      name: text(form, 'name'),
      description: text(form, 'description'),
      dataClassification: text(form, 'dataClassification', 'internal'),
      legalBasis: text(form, 'legalBasis'),
      purpose: text(form, 'purpose'),
    });
    projectId = project.id;
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath('/');
  redirect(`/projects/${projectId}`);
}

export async function setBudgetAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const { authorize, setBudget } = await getContainer();

  try {
    const { accessToken } = await authorize.execute();
    await setBudget.execute(accessToken, projectId, {
      amount: text(form, 'amount', '0'),
      currency: text(form, 'currency', 'BRL'),
      period: form.get('period') === 'daily' ? 'daily' : 'monthly',
      blockAtLimit: form.get('blockAtLimit') === 'on',
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}`);
  return {};
}

/* ------------------------------------------------------------------ */
/* Agents (aia-registry)                                               */
/* ------------------------------------------------------------------ */

function optionalNumber(form: FormData, field: string): number | undefined {
  const raw = text(form, field).trim();
  if (raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function createAgentAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const { authorize, createAgent } = await getContainer();

  let assetId: string;
  try {
    const { accessToken } = await authorize.execute();
    const created = await createAgent.execute(accessToken, projectId, {
      slug: text(form, 'slug'),
      name: text(form, 'name'),
      ...(text(form, 'description') !== '' && { description: text(form, 'description') }),
      definition: {
        kind: 'agent',
        instructions: text(form, 'instructions'),
        modelAlias: text(form, 'modelAlias'),
        tools: [],
        knowledge: [],
        ...(optionalNumber(form, 'temperature') !== undefined && {
          temperature: optionalNumber(form, 'temperature'),
        }),
      },
    });
    assetId = created.assetId;
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/agents`);
  redirect(`/projects/${projectId}/agents/${assetId}`);
}

export async function saveAgentDraftAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const assetId = text(form, 'assetId');
  const { authorize, saveAgentDraft } = await getContainer();

  try {
    const { accessToken } = await authorize.execute();
    await saveAgentDraft.execute(accessToken, projectId, assetId, {
      definition: {
        kind: 'agent',
        instructions: text(form, 'instructions'),
        modelAlias: text(form, 'modelAlias'),
        tools: [],
        knowledge: [],
        ...(optionalNumber(form, 'temperature') !== undefined && {
          temperature: optionalNumber(form, 'temperature'),
        }),
      },
      // The revision the editor last read. The registry refuses the write if it
      // moved, so a concurrent edit is reported rather than silently lost.
      expectedVersion: optionalNumber(form, 'expectedVersion') ?? 1,
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/agents/${assetId}`);
  return {};
}

export async function publishAgentAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const assetId = text(form, 'assetId');
  const { authorize, publishAgent } = await getContainer();

  try {
    const { accessToken } = await authorize.execute();
    await publishAgent.execute(accessToken, projectId, assetId);
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/agents/${assetId}`);
  revalidatePath(`/projects/${projectId}/agents`);
  return {};
}

/* ------------------------------------------------------------------ */
/* Vector stores (aia-knowledge)                                       */
/* ------------------------------------------------------------------ */

export async function createStoreAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const { authorize, createStore } = await getContainer();

  let storeId: string;
  try {
    const { accessToken } = await authorize.execute();
    const store = await createStore.execute(accessToken, projectId, {
      slug: text(form, 'slug'),
      name: text(form, 'name'),
      ...(text(form, 'description') !== '' && { description: text(form, 'description') }),
      embeddingAlias: text(form, 'embeddingAlias', 'embedding-default'),
      chunking: {
        kind: text(form, 'chunkKind', 'markdown-heading'),
        ...(optionalNumber(form, 'maxTokens') !== undefined && {
          maxTokens: optionalNumber(form, 'maxTokens'),
        }),
        ...(optionalNumber(form, 'overlapTokens') !== undefined && {
          overlapTokens: optionalNumber(form, 'overlapTokens'),
        }),
      },
    });
    storeId = store.id;
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/vector-stores`);
  redirect(`/projects/${projectId}/vector-stores/${storeId}`);
}

export async function uploadDocumentAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const storeId = text(form, 'storeId');
  const file = form.get('file');

  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a file to upload.' };
  }

  const { authorize, uploadDocument } = await getContainer();
  try {
    const { accessToken } = await authorize.execute();
    await uploadDocument.execute(accessToken, projectId, storeId, {
      name: file.name,
      // A browser sends no type for some files; the platform needs one to pick
      // a parser, and plain text is the honest guess for an unnamed type.
      type: file.type === '' ? 'text/plain' : file.type,
      bytes: await file.arrayBuffer(),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/vector-stores/${storeId}`);
  return {};
}

export async function deleteDocumentAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const storeId = text(form, 'storeId');

  const { authorize, deleteDocument } = await getContainer();
  try {
    const { accessToken } = await authorize.execute();
    await deleteDocument.execute(accessToken, projectId, storeId, text(form, 'documentId'));
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/vector-stores/${storeId}`);
  return {};
}

/**
 * Publishes a store to other projects, or withdraws it (ADR-023).
 *
 * Withdrawing drops every subscription, so the confirmation belongs in the UI
 * rather than here: this is where it becomes irreversible, not where it should
 * be questioned.
 */
export async function setStoreVisibilityAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const storeId = text(form, 'storeId');
  const visibility = text(form, 'visibility') === 'public' ? 'public' : 'private';

  const { authorize, setStoreVisibility } = await getContainer();
  try {
    const { accessToken } = await authorize.execute();
    await setStoreVisibility.execute(accessToken, projectId, storeId, visibility);
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/vector-stores/${storeId}`);
  revalidatePath(`/projects/${projectId}/vector-stores`);
  return {};
}

export async function subscribeToStoreAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const storeId = text(form, 'storeId');

  const { authorize, subscribeToStore } = await getContainer();
  try {
    const { accessToken } = await authorize.execute();
    await subscribeToStore.execute(accessToken, projectId, storeId);
  } catch (error) {
    // The likely failure is the embedding alias resolving elsewhere under this
    // project's classification. The platform explains that; passing the
    // message through unchanged is the whole point of ActionResult.
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/vector-stores`);
  return {};
}

export async function unsubscribeFromStoreAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const storeId = text(form, 'storeId');

  const { authorize, unsubscribeFromStore } = await getContainer();
  try {
    const { accessToken } = await authorize.execute();
    await unsubscribeFromStore.execute(accessToken, projectId, storeId);
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/vector-stores`);
  return {};
}

export interface SearchResult extends ActionResult {
  hits?: {
    documentId: string;
    documentTitle: string;
    chunkIndex: number;
    /** Cosine in vector mode, the fused score in hybrid. Not one scale. */
    score: number;
    retrieval: 'vector' | 'text' | 'both';
    /** The cosine, when the vector ranking reached it. */
    vectorScore?: number;
    text: string;
  }[];
  query?: string;
}

export async function searchStoreAction(
  _previous: SearchResult,
  form: FormData,
): Promise<SearchResult> {
  const projectId = text(form, 'projectId');
  const storeId = text(form, 'storeId');
  const query = text(form, 'query').trim();

  if (query === '') return {};

  const { authorize, searchStore } = await getContainer();
  try {
    const { accessToken } = await authorize.execute();
    const hits = await searchStore.execute(accessToken, projectId, storeId, query);
    return { hits, query };
  } catch (error) {
    return { error: messageFor(error), query };
  }
}

/* ------------------------------------------------------------------ */
/* Tools (aia-mcp-gateway)                                             */
/* ------------------------------------------------------------------ */

export async function bindToolAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const { authorize, bindTool } = await getContainer();

  try {
    const { accessToken } = await authorize.execute();
    await bindTool.execute(accessToken, projectId, text(form, 'toolId'), {
      enabled: form.get('enabled') !== 'false',
      ...(optionalNumber(form, 'rateLimitPerMinute') !== undefined && {
        rateLimitPerMinute: optionalNumber(form, 'rateLimitPerMinute'),
      }),
      // Only ever raised here: the gateway ignores an attempt to waive
      // approval on a high-risk tool.
      ...(form.get('requireApproval') === 'on' && { requireApproval: true }),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/tools`);
  return {};
}

export async function unbindToolAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const { authorize, unbindTool } = await getContainer();

  try {
    const { accessToken } = await authorize.execute();
    await unbindTool.execute(accessToken, projectId, text(form, 'toolId'));
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/tools`);
  return {};
}

/**
 * Naming a credential.
 *
 * There is no field for a value, here or anywhere else in the console. Whoever
 * operates the platform puts the secret in a file or an environment variable
 * (ADR-015) and names it; a form that accepted the value would put it through
 * a browser, an HTTP log and a database on the way to being useful.
 */
export async function createConnectionAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const { authorize, createConnection } = await getContainer();
  const kind = text(form, 'kind');

  try {
    const { accessToken } = await authorize.execute();
    await createConnection.execute(accessToken, projectId, {
      slug: text(form, 'slug'),
      name: text(form, 'name'),
      kind: isConnectionKind(kind) ? kind : 'bearer',
      description: text(form, 'description'),
      header: text(form, 'header'),
      secretRef: text(form, 'secretRef'),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/connections`);
  return {};
}

export async function deleteConnectionAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const { authorize, deleteConnection } = await getContainer();

  try {
    const { accessToken } = await authorize.execute();
    await deleteConnection.execute(accessToken, projectId, text(form, 'connectionId'));
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/connections`);
  return {};
}

function isConnectionKind(value: string): value is ConnectionKind {
  return value === 'bearer' || value === 'api_key' || value === 'basic' || value === 'none';
}

/**
 * Records what somebody decided about a trace they just read.
 *
 * The one write in the console that produces evidence rather than
 * configuration: this is where a failure taxonomy comes from, and where the
 * labels that calibrate a judge come from when the trace carries its text.
 */
export async function annotateTraceAction(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const projectId = text(form, 'projectId');
  const traceId = text(form, 'traceId');
  const verdict = text(form, 'verdict');

  if (verdict !== 'good' && verdict !== 'bad') {
    return { error: 'Say whether the answer was good or bad.' };
  }

  // Checked here as well as in the service. The service is what enforces it —
  // this is so the person gets the sentence back in the form rather than a
  // round trip and a Problem Details title.
  if (verdict === 'bad' && text(form, 'failureMode').trim() === '') {
    return { error: 'Say what went wrong: a verdict nobody can act on teaches nothing.' };
  }

  const { authorize, annotateTrace } = await getContainer();

  try {
    const { accessToken } = await authorize.execute();
    await annotateTrace.execute(accessToken, projectId, {
      traceId,
      verdict,
      failureMode: verdict === 'bad' ? text(form, 'failureMode') : '',
      note: text(form, 'note'),
      evaluator: text(form, 'evaluator'),
      question: text(form, 'question'),
      answer: text(form, 'answer'),
    });
  } catch (error) {
    return { error: messageFor(error) };
  }

  revalidatePath(`/projects/${projectId}/traces/${traceId}`);
  return {};
}

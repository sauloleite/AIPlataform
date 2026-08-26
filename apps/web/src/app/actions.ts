'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { getContainer } from '../container';
import { messageFor } from '../modules/console/domain/errors';

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
    return { error: messageFor(error) };
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

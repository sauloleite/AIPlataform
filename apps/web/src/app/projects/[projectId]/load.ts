import { redirect } from 'next/navigation';

import { getContainer } from '../../../container';
import type { ProjectDetail } from '../../../modules/console/application/use-cases/inspect-project';
import { messageFor, requiresSignIn } from '../../../modules/console/domain/errors';
import { canAdministerProject } from '../../../modules/console/domain/session';

export interface LoadedProject {
  detail?: ProjectDetail;
  failure?: string;
  mayAdminister: boolean;
}

/**
 * What both project pages need before they can render anything.
 *
 * Shared because the alternative is the same try/catch twice, and the branch
 * that matters -- an expired session goes to /login, a degraded platform shows
 * a notice -- is exactly the one that must not drift between two copies.
 */
export async function loadProject(projectId: string): Promise<LoadedProject> {
  const { authorize, inspectProject } = await getContainer();

  try {
    const { session, accessToken } = await authorize.execute();
    return {
      detail: await inspectProject.execute(accessToken, projectId),
      mayAdminister: canAdministerProject(session.principal, projectId),
    };
  } catch (error) {
    // redirect() works by throwing, so it stays outside the catch it would
    // otherwise be swallowed by.
    if (requiresSignIn(error)) redirect('/login');
    return { failure: messageFor(error), mayAdminister: false };
  }
}

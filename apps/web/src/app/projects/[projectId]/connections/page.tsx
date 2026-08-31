import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../container';
import { messageFor, requiresSignIn } from '../../../../modules/console/domain/errors';
import { canAdministerProject } from '../../../../modules/console/domain/session';
import type { ConnectionsView } from '../../../../modules/tools/application/use-cases/inspect-connections';
import { ConnectionList } from '../../../_ui/connection-list';

export default async function ConnectionsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, listConnections } = await getContainer();

  let view: ConnectionsView | undefined;
  let failure: string | undefined;
  let mayAdminister = false;

  try {
    const { session, accessToken } = await authorize.execute();
    mayAdminister = canAdministerProject(session.principal, projectId);
    view = await listConnections.execute(accessToken, projectId);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  if (view === undefined) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'Could not read the connections.'}
      </p>
    );
  }

  return <ConnectionList projectId={projectId} view={view} mayAdminister={mayAdminister} />;
}

import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../container';
import { messageFor, requiresSignIn } from '../../../../modules/console/domain/errors';
import { canEditAssets } from '../../../../modules/console/domain/session';
import type { AgentCard } from '../../../../modules/registry/application/use-cases/list-agents';
import { AgentList } from '../../../_ui/agent-list';

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, listAgents } = await getContainer();

  let agents: AgentCard[] = [];
  let failure: string | undefined;
  let mayEdit = false;

  try {
    const { session, accessToken } = await authorize.execute();
    mayEdit = canEditAssets(session.principal, projectId);
    agents = await listAgents.execute(accessToken, projectId);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  return (
    <AgentList
      projectId={projectId}
      agents={agents}
      mayEdit={mayEdit}
      {...(failure !== undefined && { failure })}
    />
  );
}

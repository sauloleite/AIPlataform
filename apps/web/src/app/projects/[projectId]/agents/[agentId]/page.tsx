import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../../container';
import { messageFor, requiresSignIn } from '../../../../../modules/console/domain/errors';
import { canEditAssets } from '../../../../../modules/console/domain/session';
import type { AgentDetail } from '../../../../../modules/registry/application/use-cases/inspect-agent';
import { AgentWorkbench } from '../../../../_ui/agent-workbench';

export default async function AgentPage({
  params,
}: {
  params: Promise<{ projectId: string; agentId: string }>;
}): Promise<ReactElement> {
  const { projectId, agentId } = await params;
  const { authorize, inspectAgent, inspectProject } = await getContainer();

  let agent: AgentDetail | undefined;
  let aliases: string[] = [];
  let failure: string | undefined;
  let mayEdit = false;

  try {
    const { session, accessToken } = await authorize.execute();
    mayEdit = canEditAssets(session.principal, projectId);
    agent = await inspectAgent.execute(accessToken, projectId, agentId);
    // A degraded governance must not blank the page: the alias list is a hint.
    try {
      const project = await inspectProject.execute(accessToken, projectId);
      aliases = project.aliases.map((alias: { id: string }) => alias.id);
    } catch {
      aliases = [];
    }
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  if (agent === undefined) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'Agent not found.'}
      </p>
    );
  }

  return <AgentWorkbench projectId={projectId} agent={agent} aliases={aliases} mayEdit={mayEdit} />;
}

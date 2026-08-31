import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../container';
import { messageFor, requiresSignIn } from '../../../../modules/console/domain/errors';
import { canAdministerProject } from '../../../../modules/console/domain/session';
import type { ToolCard } from '../../../../modules/tools/application/use-cases/inspect-tools';
import { ToolList } from '../../../_ui/tool-list';

export default async function ToolsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, listTools } = await getContainer();

  let tools: ToolCard[] = [];
  let failure: string | undefined;
  let mayAdminister = false;

  try {
    const { session, accessToken } = await authorize.execute();
    // Allowing a tool decides what the platform may do on somebody's behalf,
    // so it is an administrative act rather than an editorial one.
    mayAdminister = canAdministerProject(session.principal, projectId);
    const result = await listTools.execute(accessToken, projectId);
    tools = result.tools;
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  return (
    <ToolList
      projectId={projectId}
      tools={tools}
      mayAdminister={mayAdminister}
      {...(failure !== undefined && { failure })}
    />
  );
}

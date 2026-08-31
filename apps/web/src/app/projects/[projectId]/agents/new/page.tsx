import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../../container';
import { messageFor, requiresSignIn } from '../../../../../modules/console/domain/errors';
import { AgentForm } from '../../../../_ui/agent-form';

export default async function NewAgentPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, inspectProject } = await getContainer();

  // The alias list is a hint, not a constraint: the registry validates the
  // reference at publish time, and governance decides what may serve.
  let aliases: string[] = [];
  let failure: string | undefined;

  try {
    const { accessToken } = await authorize.execute();
    const detail = await inspectProject.execute(accessToken, projectId);
    aliases = detail.aliases.map((alias) => alias.id);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  return (
    <>
      {failure !== undefined && (
        <p className="notice error" role="alert">
          {failure}
        </p>
      )}
      <AgentForm
        projectId={projectId}
        aliases={aliases}
        values={{
          slug: '',
          name: '',
          description: '',
          instructions: '',
          modelAlias: aliases[0] ?? '',
          temperature: '',
        }}
      />
    </>
  );
}

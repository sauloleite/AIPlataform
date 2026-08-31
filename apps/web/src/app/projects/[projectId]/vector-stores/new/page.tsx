import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../../container';
import { messageFor, requiresSignIn } from '../../../../../modules/console/domain/errors';
import { StoreForm } from '../../../../_ui/store-form';

export default async function NewStorePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, inspectProject } = await getContainer();

  let aliases: string[] = [];
  let failure: string | undefined;

  try {
    const { accessToken } = await authorize.execute();
    const detail = await inspectProject.execute(accessToken, projectId);
    // Only an alias that can embed is a candidate; the rest would fail the
    // dimension probe with a confusing error.
    aliases = detail.aliases
      .filter((alias: { capabilities: string[] }) => alias.capabilities.includes('embeddings'))
      .map((alias: { id: string }) => alias.id);
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
      <StoreForm projectId={projectId} aliases={aliases} />
    </>
  );
}

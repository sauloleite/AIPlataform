import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../../container';
import { messageFor, requiresSignIn } from '../../../../../modules/console/domain/errors';
import { canEditAssets } from '../../../../../modules/console/domain/session';
import type { StoreDetail } from '../../../../../modules/knowledge/application/use-cases/inspect-store';
import { StoreWorkbench } from '../../../../_ui/store-workbench';

export default async function StorePage({
  params,
}: {
  params: Promise<{ projectId: string; storeId: string }>;
}): Promise<ReactElement> {
  const { projectId, storeId } = await params;
  const { authorize, inspectStore } = await getContainer();

  let store: StoreDetail | undefined;
  let failure: string | undefined;
  let mayEdit = false;

  try {
    const { session, accessToken } = await authorize.execute();
    mayEdit = canEditAssets(session.principal, projectId);
    store = await inspectStore.execute(accessToken, projectId, storeId);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  if (store === undefined) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'Vector store not found.'}
      </p>
    );
  }

  return <StoreWorkbench projectId={projectId} store={store} mayEdit={mayEdit} />;
}

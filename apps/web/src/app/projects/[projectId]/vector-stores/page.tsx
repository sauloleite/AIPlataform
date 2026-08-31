import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../container';
import { messageFor, requiresSignIn } from '../../../../modules/console/domain/errors';
import { canEditAssets } from '../../../../modules/console/domain/session';
import type { StoreSummary } from '../../../../modules/knowledge/application/ports';
import { StoreList } from '../../../_ui/store-list';

export default async function VectorStoresPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, listStores, listCatalogue } = await getContainer();

  let stores: StoreSummary[] = [];
  let catalogue: StoreSummary[] = [];
  let failure: string | undefined;
  let mayEdit = false;

  try {
    const { session, accessToken } = await authorize.execute();
    mayEdit = canEditAssets(session.principal, projectId);
    [stores, catalogue] = await Promise.all([
      listStores.execute(accessToken, projectId),
      listCatalogue.execute(accessToken, projectId),
    ]);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  return (
    <StoreList
      projectId={projectId}
      stores={stores}
      catalogue={catalogue}
      mayEdit={mayEdit}
      {...(failure !== undefined && { failure })}
    />
  );
}

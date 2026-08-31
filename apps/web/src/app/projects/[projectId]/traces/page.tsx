import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../container';
import { messageFor, requiresSignIn } from '../../../../modules/console/domain/errors';
import type { TraceListView } from '../../../../modules/observability/application/use-cases/inspect-traces';
import { TraceList } from '../../../_ui/trace-list';

export const dynamic = 'force-dynamic';

export default async function TracesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, listTraces } = await getContainer();

  let view: TraceListView | undefined;
  let failure: string | undefined;

  try {
    await authorize.execute();
    view = await listTraces.execute(projectId);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  if (view === undefined) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'Could not read the traces.'}
      </p>
    );
  }

  return <TraceList projectId={projectId} view={view} />;
}

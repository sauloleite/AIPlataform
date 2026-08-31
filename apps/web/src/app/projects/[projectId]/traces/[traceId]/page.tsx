import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../../container';
import { messageFor, requiresSignIn } from '../../../../../modules/console/domain/errors';
import type { TraceDetail } from '../../../../../modules/observability/domain/trace';
import { TraceDetailView } from '../../../../_ui/trace-detail';

export const dynamic = 'force-dynamic';

export default async function TracePage({
  params,
}: {
  params: Promise<{ projectId: string; traceId: string }>;
}): Promise<ReactElement> {
  const { projectId, traceId } = await params;
  const { authorize, inspectTrace } = await getContainer();

  let trace: TraceDetail | null = null;
  let failure: string | undefined;

  try {
    await authorize.execute();
    trace = await inspectTrace.execute(traceId);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  // A trace belonging to another project is not shown. The backend filter is
  // on the LIST; a trace id read straight from the URL has to be checked here
  // too, or knowing an id would be enough to read the neighbour's request.
  if (trace?.projectId !== undefined && trace.projectId !== projectId) {
    trace = null;
  }

  if (trace === null) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'That trace is not available.'}
      </p>
    );
  }

  return <TraceDetailView trace={trace} />;
}

import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../../container';
import { messageFor, requiresSignIn } from '../../../../../modules/console/domain/errors';
import type { AnnotationPage } from '../../../../../modules/observability/application/evaluation-ports';
import type { TraceDetail } from '../../../../../modules/observability/domain/trace';
import { TraceAnnotations } from '../../../../_ui/trace-annotations';
import { TraceDetailView } from '../../../../_ui/trace-detail';

export const dynamic = 'force-dynamic';

export default async function TracePage({
  params,
}: {
  params: Promise<{ projectId: string; traceId: string }>;
}): Promise<ReactElement> {
  const { projectId, traceId } = await params;
  const { authorize, inspectTrace, readAnnotations } = await getContainer();

  let trace: TraceDetail | null = null;
  let annotations: AnnotationPage = { items: [], taxonomy: [] };
  let failure: string | undefined;

  let annotationsUnavailable = false;

  try {
    const { accessToken } = await authorize.execute();
    trace = await inspectTrace.execute(traceId);

    // Separately, and swallowed on purpose: the annotations are on this screen
    // because reading a trace and saying what was wrong with it is one
    // activity, but an evaluation service that is down must not take the trace
    // view with it. Empty is reported as "could not read" rather than rendered
    // as "nobody has annotated this", which is a different fact.
    try {
      annotations = await readAnnotations.execute(accessToken, projectId, { traceId });
    } catch {
      annotationsUnavailable = true;
    }
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

  return (
    <>
      <TraceDetailView trace={trace} />
      <TraceAnnotations
        projectId={projectId}
        traceId={traceId}
        annotations={annotations.items}
        taxonomy={annotations.taxonomy}
        unavailable={annotationsUnavailable}
      />
    </>
  );
}

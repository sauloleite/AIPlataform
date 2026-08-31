import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../../container';
import { messageFor, requiresSignIn } from '../../../../modules/console/domain/errors';
import type { EvaluationsView } from '../../../../modules/observability/application/use-cases/inspect-evaluations';
import { EvaluationList } from '../../../_ui/evaluation-list';

export const dynamic = 'force-dynamic';

export default async function EvaluationsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, listEvaluations } = await getContainer();

  let view: EvaluationsView | undefined;
  let failure: string | undefined;

  try {
    const { accessToken } = await authorize.execute();
    view = await listEvaluations.execute(accessToken, projectId);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  if (view === undefined) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'Could not read the evaluation runs.'}
      </p>
    );
  }

  return <EvaluationList view={view} />;
}

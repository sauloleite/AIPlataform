import type { ReactElement } from 'react';

import { BudgetCard, GovernanceCard } from '../cards';
import { loadProject } from '../load';

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { detail, failure, mayAdminister } = await loadProject(projectId);

  if (detail === undefined) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'Project not found.'}
      </p>
    );
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">
        <span className="slug">{detail.slug}</span> · what this project may spend and where its data
        may be processed.
      </p>

      <div className="columns">
        <GovernanceCard detail={detail} />
        <BudgetCard detail={detail} mayAdminister={mayAdminister} />
      </div>
    </>
  );
}

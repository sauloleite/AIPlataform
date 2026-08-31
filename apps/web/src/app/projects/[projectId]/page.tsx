import type { ReactElement } from 'react';

import { AliasCatalogue, BudgetMeter } from './cards';
import { loadProject } from './load';

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { detail, failure } = await loadProject(projectId);

  if (detail === undefined) {
    return (
      <p className="notice error" role="alert">
        {failure ?? 'Project not found.'}
      </p>
    );
  }

  return (
    <>
      <h1>{detail.name}</h1>
      <p className="lede">
        <span className="slug">{detail.slug}</span> · {detail.classificationLabel}
      </p>

      <section className="card" style={{ maxWidth: 520 }}>
        <h2>Budget</h2>
        {detail.budget === undefined ? (
          <p className="empty" style={{ padding: 18 }}>
            No budget set for this period.
          </p>
        ) : (
          <>
            <dl className="pairs">
              <dt>Spent</dt>
              <dd>
                {detail.budget.spent} of {detail.budget.limit}
              </dd>
              <dt>Remaining</dt>
              <dd>{detail.budget.remaining}</dd>
            </dl>
            <BudgetMeter ratio={detail.budget.ratio} />
          </>
        )}
      </section>

      <AliasCatalogue aliases={detail.aliases} />

      <p style={{ marginTop: 28 }}>
        <a href={`/chat?project=${detail.id}`}>Open the playground for this project →</a>
      </p>
    </>
  );
}

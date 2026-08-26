import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../../container';
import { canAdministerProject } from '../../../modules/console/domain/session';
import { messageFor, requiresSignIn } from '../../../modules/console/domain/errors';
import type { ProjectDetail } from '../../../modules/console/application/use-cases/inspect-project';
import type { ModelAliasSummary } from '../../../modules/console/application/ports';
import { BudgetForm } from './budget-form';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactElement> {
  const { projectId } = await params;
  const { authorize, inspectProject } = await getContainer();

  let detail: ProjectDetail | undefined;
  let failure: string | undefined;
  let mayAdminister = false;

  try {
    const { session, accessToken } = await authorize.execute();
    mayAdminister = canAdministerProject(session.principal, projectId);
    detail = await inspectProject.execute(accessToken, projectId);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

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

      <div className="columns">
        <GovernanceCard detail={detail} />
        <BudgetCard detail={detail} mayAdminister={mayAdminister} />
      </div>

      <AliasCatalogue aliases={detail.aliases} />

      <p style={{ marginTop: 28 }}>
        <a href={`/chat?project=${detail.id}`}>Open the playground for this project →</a>
      </p>
    </>
  );
}

function GovernanceCard({ detail }: { detail: ProjectDetail }): ReactElement {
  return (
    <section className="card">
      <h2>Governance</h2>
      <dl className="pairs">
        <dt>Classification</dt>
        <dd>{detail.classificationLabel}</dd>
        <dt>Legal basis</dt>
        <dd>{detail.legalBasis ?? '—'}</dd>
        <dt>Purpose</dt>
        <dd>{detail.purpose ?? '—'}</dd>
        {detail.policy !== undefined && (
          <>
            <dt>Allowed zones</dt>
            <dd>{detail.policy.allowedDataZones.join(', ')}</dd>
            <dt>Max concurrency</dt>
            <dd>{detail.policy.maxConcurrentRequests}</dd>
            <dt>Content capture</dt>
            <dd>{detail.policy.contentCapture ? 'on, after redaction' : 'off'}</dd>
            <dt>Policy version</dt>
            <dd>{detail.policy.version}</dd>
          </>
        )}
      </dl>

      {/* A policy may narrow what the classification allows, never widen it.
          Showing the difference makes that rule legible instead of implied. */}
      {detail.narrowedZones.length > 0 && (
        <p className="notice">
          The policy narrows this project further: {detail.narrowedZones.join(', ')}{' '}
          {detail.narrowedZones.length === 1 ? 'is' : 'are'} permitted by the classification but
          switched off here.
        </p>
      )}
    </section>
  );
}

function BudgetCard({
  detail,
  mayAdminister,
}: {
  detail: ProjectDetail;
  mayAdminister: boolean;
}): ReactElement {
  const budget = detail.budget;

  return (
    <section className="card">
      <h2>Budget</h2>
      {budget === undefined ? (
        <p className="empty" style={{ padding: 18 }}>
          No budget set for this period.
        </p>
      ) : (
        <>
          <dl className="pairs">
            <dt>Limit</dt>
            <dd>
              {budget.limit} / {budget.period}
            </dd>
            <dt>Spent</dt>
            <dd>{budget.spent}</dd>
            {budget.reserved !== undefined && (
              <>
                <dt>Reserved</dt>
                <dd>{budget.reserved}</dd>
              </>
            )}
            <dt>Remaining</dt>
            <dd>{budget.remaining}</dd>
            <dt>At the limit</dt>
            <dd>{budget.blockAtLimit ? 'refuses new calls' : 'alerts only'}</dd>
          </dl>
          <div className="meter">
            <i className={toneFor(budget.ratio)} style={{ width: widthFor(budget.ratio) }} />
          </div>
        </>
      )}

      {mayAdminister && (
        <div style={{ marginTop: 18 }}>
          <BudgetForm
            projectId={detail.id}
            amount={budget?.limitAmount ?? '0.00'}
            currency={budget?.currency ?? 'BRL'}
            period={budget?.period ?? 'monthly'}
            blockAtLimit={budget?.blockAtLimit ?? true}
          />
        </div>
      )}
    </section>
  );
}

function AliasCatalogue({ aliases }: { aliases: ModelAliasSummary[] }): ReactElement {
  return (
    <section style={{ marginTop: 24 }}>
      <h2>Models this project may use</h2>
      {aliases.length === 0 ? (
        <p className="empty">
          No alias is compatible with this project&apos;s classification. A call would be refused
          with <code>no_compatible_deployment</code> rather than sent anyway.
        </p>
      ) : (
        <div className="grid">
          {aliases.map((alias) => (
            <div className="card" key={alias.id}>
              <div className="card-head">
                <strong>{alias.id}</strong>
                {alias.maxOutputTokens !== undefined && (
                  <span className="slug">max {alias.maxOutputTokens}</span>
                )}
              </div>
              {alias.description !== undefined && <p className="lede">{alias.description}</p>}
              <div className="badges">
                {alias.dataZones.map((zone) => (
                  <span className={zone === 'local' ? 'badge ok' : 'badge'} key={zone}>
                    {zone}
                  </span>
                ))}
                {alias.capabilities.map((capability) => (
                  <span className="badge" key={capability}>
                    {capability}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** 80% is the first alert threshold the platform uses; 100% is where it blocks. */
export function toneFor(ratio: number): string {
  if (ratio >= 1) return 'danger';
  if (ratio >= 0.8) return 'warn';
  return '';
}

export function widthFor(ratio: number): string {
  return `${Math.min(100, Math.round(ratio * 100)).toString()}%`;
}

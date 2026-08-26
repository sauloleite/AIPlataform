import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../container';
import { canCreateProject } from '../modules/console/domain/session';
import { messageFor, requiresSignIn } from '../modules/console/domain/errors';
import type { ProjectCard } from '../modules/console/application/use-cases/list-projects';
import { CreateProjectForm } from './create-project-form';

export default async function ProjectsPage(): Promise<ReactElement> {
  const { authorize, listProjects } = await getContainer();

  let projects: ProjectCard[] = [];
  let failure: string | undefined;
  let mayCreate = false;

  try {
    const { session, accessToken } = await authorize.execute();
    mayCreate = canCreateProject(session.principal);
    projects = await listProjects.execute(accessToken);
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  return (
    <>
      <h1>Projects</h1>
      <p className="lede">
        A project is the platform tenant. Its data classification decides which models may serve it,
        and its budget is spent in currency, not in tokens.
      </p>

      {failure !== undefined && (
        <p className="notice error" role="alert">
          {failure}
        </p>
      )}

      {projects.length === 0 && failure === undefined ? (
        <p className="empty">No project yet. Create the first one below.</p>
      ) : (
        <div className="grid">
          {projects.map((project) => (
            <ProjectTile key={project.id} project={project} />
          ))}
        </div>
      )}

      {mayCreate && (
        <section style={{ marginTop: 36 }}>
          <h2>New project</h2>
          <div className="card" style={{ maxWidth: 560 }}>
            <CreateProjectForm />
          </div>
        </section>
      )}
    </>
  );
}

function ProjectTile({ project }: { project: ProjectCard }): ReactElement {
  return (
    <a className="card card-link" href={`/projects/${project.id}`}>
      <div className="card-head">
        <strong>{project.name}</strong>
        <span className="slug">{project.slug}</span>
      </div>

      {project.budget !== undefined && <BudgetMeter budget={project.budget} />}

      <div className="badges">
        <span className="badge">{project.classificationLabel}</span>
        {/* The one badge worth reading twice: this project cannot leave the machine. */}
        {project.localOnly && <span className="badge accent">local model only</span>}
        {project.budget?.blockAtLimit === false && (
          <span className="badge warn">alerts, does not block</span>
        )}
      </div>
    </a>
  );
}

function BudgetMeter({ budget }: { budget: NonNullable<ProjectCard['budget']> }): ReactElement {
  const percent = Math.min(100, Math.round(budget.ratio * 100));
  const tone = budget.ratio >= 1 ? 'danger' : budget.ratio >= 0.8 ? 'warn' : '';

  return (
    <>
      <div className="meter">
        <i className={tone} style={{ width: `${percent.toString()}%` }} />
      </div>
      <div className="meter-caption">
        <span>
          {budget.spent} of {budget.limit}
        </span>
        <span>{percent}%</span>
      </div>
    </>
  );
}

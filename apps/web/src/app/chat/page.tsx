import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../container';
import { messageFor, requiresSignIn } from '../../modules/console/domain/errors';
import type { ProjectCard } from '../../modules/console/application/use-cases/list-projects';
import type { ModelAliasSummary } from '../../modules/console/application/ports';
import { Playground } from './playground';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const { project: requested } = await searchParams;
  const { authorize, listProjects, inspectProject } = await getContainer();

  let projects: ProjectCard[] = [];
  let aliases: ModelAliasSummary[] = [];
  let selected: string | undefined;
  let failure: string | undefined;

  try {
    const { accessToken } = await authorize.execute();
    projects = await listProjects.execute(accessToken);
    selected = requested ?? projects[0]?.id;

    if (selected !== undefined) {
      // The alias catalogue is per project: the router only lists what this
      // project's classification permits, so the picker cannot offer a model
      // that would come back as `no_compatible_deployment`.
      aliases = (await inspectProject.execute(accessToken, selected)).aliases;
    }
  } catch (error) {
    if (requiresSignIn(error)) redirect('/login');
    failure = messageFor(error);
  }

  if (failure !== undefined) {
    return (
      <p className="notice error" role="alert">
        {failure}
      </p>
    );
  }

  if (selected === undefined) {
    return <p className="empty">Create a project before using the playground.</p>;
  }

  const project = projects.find((candidate) => candidate.id === selected);

  return (
    <>
      <h1>Playground</h1>
      <p className="lede">
        Every answer says how it was served: which provider, in which data zone and at what cost. A
        restricted project is answered by the local model, and the panel proves it.
      </p>

      <Playground
        projects={projects.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          localOnly: candidate.localOnly,
        }))}
        selectedProjectId={selected}
        aliases={aliases.map((alias) => ({ id: alias.id, dataZones: alias.dataZones }))}
        localOnly={project?.localOnly ?? false}
      />
    </>
  );
}

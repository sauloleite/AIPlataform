import { Inject, Injectable } from '@nestjs/common';
import { ConflictError } from '@aia/errors';
import { EVENT_TYPES, newEvent } from '@aia/messaging';
import { Project } from '../../domain/entities/project.js';
import { DataClassification } from '../../domain/value-objects/data-classification.js';
import {
  CLOCK,
  ID_GENERATOR,
  PROJECT_REPOSITORY,
  type Clock,
  type IdGenerator,
  type ProjectRepository,
} from '../ports.js';
import type { CreateProjectCommand, ProjectView } from '../dto.js';
import { toProjectView } from '../mappers.js';

const SOURCE = '/aia/governance';

@Injectable()
export class CreateProject {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CreateProjectCommand): Promise<ProjectView> {
    const existing = await this.projects.findBySlug(command.slug);
    if (existing !== null) {
      throw new ConflictError('Ja existe um projeto com este slug', { slug: command.slug });
    }

    const project = Project.create({
      id: this.ids.next(),
      slug: command.slug,
      name: command.name,
      ...(command.description !== undefined && { description: command.description }),
      classification: DataClassification.of(command.dataClassification),
      legalBasis: command.legalBasis,
      purpose: command.purpose,
      ...(command.costCenter !== undefined && { costCenter: command.costCenter }),
      ...(command.ownerPrincipalId !== undefined && { ownerPrincipalId: command.ownerPrincipalId }),
      now: this.clock.now(),
    });

    // O evento vai na mesma transacao do estado (outbox), nunca depois dela.
    await this.projects.save(project, [
      newEvent({
        type: EVENT_TYPES.PROJECT_CREATED,
        source: SOURCE,
        projectId: project.id,
        time: this.clock.now(),
        data: {
          project_id: project.id,
          slug: project.slug,
          name: project.name,
          data_classification: project.classification.level,
          ...(command.ownerPrincipalId !== undefined && {
            owner_principal_id: command.ownerPrincipalId,
          }),
        },
      }),
    ]);

    return toProjectView(project);
  }
}

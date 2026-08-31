import { Inject, Injectable } from '@nestjs/common';

import { Connection } from '../../domain/entities/connection.js';
import {
  ConnectionInUseError,
  ConnectionNotFoundError,
  ConnectionSlugTakenError,
} from '../../domain/errors/index.js';
import type { ConnectionView, CreateConnectionCommand } from '../dto.js';
import {
  CLOCK,
  CONNECTION_REPOSITORY,
  ID_GENERATOR,
  SECRET_RESOLVER,
  TOOL_CATALOG,
  type Clock,
  type ConnectionRepository,
  type IdGenerator,
  type SecretResolver,
  type ToolCatalog,
} from '../ports.js';

/**
 * Reading the project's connections.
 *
 * `resolved` is the only reason this touches the resolver at all: whether the
 * named secret is actually there. An operator seeing `false` here fixes it
 * before a user meets a tool that fails for a reason nobody can explain.
 * The VALUE never leaves the resolver.
 */
@Injectable()
export class ListConnections {
  constructor(
    @Inject(CONNECTION_REPOSITORY) private readonly connections: ConnectionRepository,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
  ) {}

  async execute(projectId: string): Promise<ConnectionView[]> {
    const found = await this.connections.list(projectId);

    return Promise.all(
      found.map(async (connection) => {
        const snapshot = connection.snapshot;
        return {
          id: snapshot.id,
          projectId: snapshot.projectId,
          slug: snapshot.slug,
          name: snapshot.name,
          ...(snapshot.description !== undefined && { description: snapshot.description }),
          kind: snapshot.kind,
          header: snapshot.header,
          secretRef: snapshot.secretRef,
          resolved: await isResolved(connection, this.secrets),
          createdAt: snapshot.createdAt.toISOString(),
          updatedAt: snapshot.updatedAt.toISOString(),
        };
      }),
    );
  }
}

@Injectable()
export class CreateConnection {
  constructor(
    @Inject(CONNECTION_REPOSITORY) private readonly connections: ConnectionRepository,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateConnectionCommand): Promise<ConnectionView> {
    const existing = await this.connections.findBySlug(command.projectId, command.slug);
    if (existing !== null) throw new ConnectionSlugTakenError(command.slug);

    const connection = Connection.create({
      id: this.ids.next(),
      projectId: command.projectId,
      slug: command.slug,
      name: command.name,
      ...(command.description !== undefined && { description: command.description }),
      kind: command.kind,
      ...(command.header !== undefined && { header: command.header }),
      secretRef: command.secretRef ?? '',
      now: this.clock.now(),
    });

    await this.connections.save(connection);

    const snapshot = connection.snapshot;
    return {
      id: snapshot.id,
      projectId: snapshot.projectId,
      slug: snapshot.slug,
      name: snapshot.name,
      ...(snapshot.description !== undefined && { description: snapshot.description }),
      kind: snapshot.kind,
      header: snapshot.header,
      secretRef: snapshot.secretRef,
      // Reported straight away rather than left for a first failed call: a
      // connection created against a secret nobody mounted is the common
      // mistake, and this is the moment somebody is looking.
      resolved: await isResolved(connection, this.secrets),
      createdAt: snapshot.createdAt.toISOString(),
      updatedAt: snapshot.updatedAt.toISOString(),
    };
  }
}

@Injectable()
export class DeleteConnection {
  constructor(
    @Inject(CONNECTION_REPOSITORY) private readonly connections: ConnectionRepository,
    @Inject(TOOL_CATALOG) private readonly catalog: ToolCatalog,
  ) {}

  async execute(input: {
    projectId: string;
    connectionId: string;
    accessToken: string;
  }): Promise<void> {
    // Refused while a published tool still points at it. Deleting anyway would
    // break that tool at its next call, with an error naming a connection that
    // no longer exists to look up.
    const tools = await this.catalog.list(input);
    const user = tools.find((tool) => tool.connectionId === input.connectionId);
    if (user !== undefined) throw new ConnectionInUseError(input.connectionId, user.name);

    const removed = await this.connections.remove(input.projectId, input.connectionId);
    if (!removed) throw new ConnectionNotFoundError(input.connectionId);
  }
}

async function isResolved(connection: Connection, secrets: SecretResolver): Promise<boolean> {
  if (!connection.needsSecret) return true;
  return (await secrets.resolve(connection.secretRef)) !== null;
}

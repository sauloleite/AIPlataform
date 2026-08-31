import type { ConnectionSummary, CreateConnectionInput, ToolsGateway } from '../ports';

/**
 * The project's connections, and what is wrong with them.
 *
 * `unresolved` is the number worth putting on screen: a connection naming a
 * secret nobody mounted looks completely normal until a tool fails in front of
 * a user, and by then the error names a header rather than the mistake.
 */
export interface ConnectionsView {
  connections: ConnectionSummary[];
  unresolved: number;
}

export function summarise(connections: ConnectionSummary[]): ConnectionsView {
  return {
    connections,
    unresolved: connections.filter((connection) => !connection.resolved).length,
  };
}

export class ListConnections {
  constructor(private readonly tools: ToolsGateway) {}

  async execute(accessToken: string, projectId: string): Promise<ConnectionsView> {
    return summarise(await this.tools.listConnections(accessToken, projectId));
  }
}

export class CreateConnection {
  constructor(private readonly tools: ToolsGateway) {}

  execute(
    accessToken: string,
    projectId: string,
    input: CreateConnectionInput,
  ): Promise<ConnectionSummary> {
    return this.tools.createConnection(accessToken, projectId, input);
  }
}

export class DeleteConnection {
  constructor(private readonly tools: ToolsGateway) {}

  execute(accessToken: string, projectId: string, connectionId: string): Promise<void> {
    return this.tools.deleteConnection(accessToken, projectId, connectionId);
  }
}

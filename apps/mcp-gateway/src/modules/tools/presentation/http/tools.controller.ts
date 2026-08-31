import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Post,
  Req,
} from '@nestjs/common';
import { POLICY, authorize } from '@aia/auth';
import { principalOf, projectIdOf, type AuthenticatedRequest } from '@aia/nest';

import { InvokeTool } from '../../application/use-cases/invoke-tool.js';
import { ListEffectiveTools } from '../../application/use-cases/list-effective-tools.js';
import { BindTool, ListBindings, UnbindTool } from '../../application/use-cases/manage-bindings.js';
import {
  CreateConnection,
  DeleteConnection,
  ListConnections,
} from '../../application/use-cases/manage-connections.js';
import { parseBind, parseCreateConnection, parseInvoke } from './dto.js';
import {
  toBindingResponse,
  toConnectionResponse,
  toEffectiveToolResponse,
  toInvocationResponse,
} from './mappers.js';

/** Adapts HTTP to the use cases. No business rule here. */
@Controller('v1')
export class ToolsController {
  constructor(
    @Inject(ListEffectiveTools) private readonly listTools: ListEffectiveTools,
    @Inject(InvokeTool) private readonly invokeTool: InvokeTool,
    @Inject(ListBindings) private readonly listBindings: ListBindings,
    @Inject(BindTool) private readonly bindTool: BindTool,
    @Inject(UnbindTool) private readonly unbindTool: UnbindTool,
    @Inject(ListConnections) private readonly listConnections: ListConnections,
    @Inject(CreateConnection) private readonly createConnection: CreateConnection,
    @Inject(DeleteConnection) private readonly deleteConnection: DeleteConnection,
  ) {}

  @Get('tools')
  async tools(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: null }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });

    const items = await this.listTools.execute({
      projectId,
      accessToken: bearerOf(request),
    });
    return { items: items.map(toEffectiveToolResponse), next_cursor: null };
  }

  @Post('tools/:toolId/invoke')
  @HttpCode(200)
  async invoke(
    @Req() request: AuthenticatedRequest,
    @Param('toolId') toolId: string,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    const principal = principalOf(request);
    // The fine-grained decision (allow-list, risk, approval) is the use case's;
    // this only refuses somebody with no business in the project at all.
    authorize(POLICY.READ_PROJECT, { principal, projectId });

    const body = parseInvoke(rawBody);
    const result = await this.invokeTool.execute(
      {
        projectId,
        toolId,
        principalId: principal.id,
        accessToken: bearerOf(request),
        arguments: body.arguments,
        ...(body.approval_id !== undefined && { approvalId: body.approval_id }),
      },
      principal,
    );
    return toInvocationResponse(result);
  }

  @Get('bindings')
  async bindings(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: Record<string, unknown>[] }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    const items = await this.listBindings.execute(projectId);
    return { items: items.map(toBindingResponse) };
  }

  @Put('bindings/:toolId')
  async bind(
    @Req() request: AuthenticatedRequest,
    @Param('toolId') toolId: string,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    // Allowing a tool in a project is an administrative act, not an editorial
    // one: it decides what the platform may do on somebody's behalf.
    authorize(POLICY.MANAGE_BUDGET, { principal: principalOf(request), projectId });

    const body = parseBind(rawBody);
    const binding = await this.bindTool.execute({
      projectId,
      toolId,
      accessToken: bearerOf(request),
      enabled: body.enabled,
      ...(body.rate_limit_per_minute !== undefined &&
        body.rate_limit_per_minute !== null && {
          rateLimitPerMinute: body.rate_limit_per_minute,
        }),
      ...(body.require_approval !== undefined &&
        body.require_approval !== null && { requireApproval: body.require_approval }),
    });
    return toBindingResponse(binding);
  }

  @Delete('bindings/:toolId')
  @HttpCode(204)
  async unbind(
    @Req() request: AuthenticatedRequest,
    @Param('toolId') toolId: string,
  ): Promise<void> {
    const projectId = projectIdOf(request);
    authorize(POLICY.MANAGE_BUDGET, { principal: principalOf(request), projectId });
    await this.unbindTool.execute(projectId, toolId);
  }

  @Get('connections')
  async connections(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: null }> {
    const projectId = projectIdOf(request);
    // Reading a connection reveals no credential, so a viewer may see which
    // endpoints a project reaches -- and whether one is broken.
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });

    const items = await this.listConnections.execute(projectId);
    return { items: items.map(toConnectionResponse), next_cursor: null };
  }

  @Post('connections')
  @HttpCode(201)
  async createConnectionEndpoint(
    @Req() request: AuthenticatedRequest,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    // Naming a credential the platform will present as itself is an
    // administrative act, like allowing a tool.
    authorize(POLICY.MANAGE_BUDGET, { principal: principalOf(request), projectId });

    const body = parseCreateConnection(rawBody);
    const connection = await this.createConnection.execute({
      projectId,
      slug: body.slug,
      name: body.name,
      kind: body.kind,
      ...(body.description !== undefined && { description: body.description }),
      ...(body.header !== undefined && { header: body.header }),
      ...(body.secret_ref !== undefined && { secretRef: body.secret_ref }),
    });
    return toConnectionResponse(connection);
  }

  @Delete('connections/:connectionId')
  @HttpCode(204)
  async removeConnection(
    @Req() request: AuthenticatedRequest,
    @Param('connectionId') connectionId: string,
  ): Promise<void> {
    const projectId = projectIdOf(request);
    authorize(POLICY.MANAGE_BUDGET, { principal: principalOf(request), projectId });
    await this.deleteConnection.execute({
      projectId,
      connectionId,
      accessToken: bearerOf(request),
    });
  }
}

/** The caller's own token: an INTERNAL call acts as them, not as the gateway. */
function bearerOf(request: AuthenticatedRequest): string {
  const header = (request.headers as Record<string, unknown>)['authorization'];
  if (typeof header !== 'string') return '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

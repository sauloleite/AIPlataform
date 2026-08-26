import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { NoProject, principalOf, type AuthenticatedRequest } from '@aia/nest';
import { POLICY, ROLES, authorize, hasRole, isPlatformAdmin } from '@aia/auth';
import { ForbiddenError, NotFoundError, ValidationError } from '@aia/errors';
import { CreateProject } from '../../application/use-cases/create-project.js';
import { GetProjectPolicy } from '../../application/use-cases/get-project-policy.js';
import { SetBudget } from '../../application/use-cases/set-budget.js';
import { SetProjectPolicy } from '../../application/use-cases/set-project-policy.js';
import {
  BUDGET_REPOSITORY,
  PROJECT_REPOSITORY,
  type BudgetRepository,
  type ProjectRepository,
} from '../../application/ports.js';
import { toBudgetView, toProjectView } from '../../application/mappers.js';
import { z } from 'zod';
import {
  createProjectSchema,
  listQuerySchema,
  setBudgetSchema,
  setPolicySchema,
} from './dto.schema.js';

/**
 * Validates the body and turns a schema failure into a domain error.
 *
 * Edge validation describes the HTTP CONTRACT; business rules live in the
 * domain, not here.
 */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Invalid body', {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data as z.infer<S>;
}

/**
 * The project routes use `@NoProject()` because the project comes from the URL
 * path, not the header: this is the one service that operates ON the tenant
 * rather than INSIDE it.
 */
@NoProject()
@Controller('v1/projects')
export class ProjectsController {
  constructor(
    private readonly createProject: CreateProject,
    private readonly setBudgetUseCase: SetBudget,
    private readonly getPolicy: GetProjectPolicy,
    private readonly setPolicy: SetProjectPolicy,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(BUDGET_REPOSITORY) private readonly budgets: BudgetRepository,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const principal = principalOf(request);
    if (!isPlatformAdmin(principal)) {
      throw new ForbiddenError('Only platform_admin may create a project', {
        rule: 'platform_admin',
      });
    }

    const input = parseOrThrow(createProjectSchema, body);
    const project = await this.createProject.execute({
      slug: input.slug,
      name: input.name,
      ...(input.description !== undefined && { description: input.description }),
      dataClassification: input.data_classification,
      legalBasis: input.legal_basis,
      purpose: input.purpose,
      ...(input.cost_center !== undefined && { costCenter: input.cost_center }),
      ownerPrincipalId: input.owner_principal_id ?? principal.id,
    });

    return serializeProject(project);
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const principal = principalOf(request);
    const { limit, cursor } = parseOrThrow(listQuerySchema, query);
    const page = await this.projects.list({ limit, ...(cursor !== undefined && { cursor }) });

    // Tenant filter on the way out: a viewer never sees a project they are not in.
    const visible = isPlatformAdmin(principal)
      ? page.items
      : page.items.filter((project) =>
          principal.memberships.some((m) => m.projectId === project.id),
        );

    return {
      items: visible.map((project) => serializeProject(toProjectView(project))),
      next_cursor: page.nextCursor,
    };
  }

  @Get(':projectId')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
  ): Promise<Record<string, unknown>> {
    const project = await this.projects.findById(projectId);
    if (project === null) throw new NotFoundError('Project', projectId);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return serializeProject(toProjectView(project));
  }

  @Put(':projectId/budget')
  async setBudget(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    authorize(POLICY.MANAGE_BUDGET, { principal: principalOf(request), projectId });
    const input = parseOrThrow(setBudgetSchema, body);

    const budget = await this.setBudgetUseCase.execute({
      projectId,
      limitMicros: input.limit.micros,
      currency: input.limit.currency,
      period: input.period,
      ...(input.block_at_limit !== undefined && { blockAtLimit: input.block_at_limit }),
      ...(input.alert_thresholds !== undefined && { alertThresholds: input.alert_thresholds }),
    });

    return serializeBudget(budget);
  }

  @Get(':projectId/budget')
  async getBudget(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
  ): Promise<Record<string, unknown>> {
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    const budget = await this.budgets.findByProject(projectId);
    if (budget === null) throw new NotFoundError('Budget', projectId);
    return serializeBudget(toBudgetView(budget));
  }

  @Get(':projectId/policy')
  async policy(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
  ): Promise<Record<string, unknown>> {
    const principal = principalOf(request);
    // The inference router calls with a service token; a user must be a member.
    if (principal.type !== 'service') {
      authorize(POLICY.READ_PROJECT, { principal, projectId });
    }

    const policy = await this.getPolicy.execute(projectId);
    return {
      project_id: policy.projectId,
      data_classification: policy.dataClassification,
      allowed_data_zones: policy.allowedDataZones,
      model_rules: policy.modelRules.map((rule) => ({
        alias: rule.alias,
        allowed: rule.allowed,
        ...(rule.maxOutputTokens !== undefined && { max_output_tokens: rule.maxOutputTokens }),
      })),
      max_concurrent_requests: policy.maxConcurrentRequests,
      content_capture: policy.contentCapture,
      version: policy.version,
      ...(policy.budget !== undefined && {
        budget: {
          currency: policy.budget.currency,
          limit_micros: policy.budget.limitMicros,
          spent_micros: policy.budget.spentMicros,
          reserved_micros: policy.budget.reservedMicros,
          block_at_limit: policy.budget.blockAtLimit,
          period_end: policy.budget.periodEnd.toISOString(),
        },
      }),
    };
  }

  @Put(':projectId/policy')
  async updatePolicy(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    // Policy decides who may spend and where data may go: only the owner edits it.
    authorize(hasRole(ROLES.PROJECT_OWNER), { principal: principalOf(request), projectId });
    const input = parseOrThrow(setPolicySchema, body);

    const policy = await this.setPolicy.execute({
      projectId,
      ...(input.allowed_data_zones !== undefined && { allowedDataZones: input.allowed_data_zones }),
      ...(input.model_rules !== undefined && {
        modelRules: input.model_rules.map((rule) => ({
          alias: rule.alias,
          allowed: rule.allowed,
          ...(rule.max_output_tokens !== undefined && { maxOutputTokens: rule.max_output_tokens }),
        })),
      }),
      ...(input.max_concurrent_requests !== undefined && {
        maxConcurrentRequests: input.max_concurrent_requests,
      }),
      ...(input.content_capture !== undefined && { contentCapture: input.content_capture }),
    });

    return {
      project_id: policy.projectId,
      data_classification: policy.dataClassification,
      allowed_data_zones: policy.allowedDataZones,
      version: policy.version,
    };
  }
}

function serializeProject(project: ReturnType<typeof toProjectView>): Record<string, unknown> {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    data_classification: project.dataClassification,
    legal_basis: project.legalBasis,
    purpose: project.purpose,
    cost_center: project.costCenter,
    owner_principal_id: project.ownerPrincipalId,
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}

function serializeBudget(budget: ReturnType<typeof toBudgetView>): Record<string, unknown> {
  return {
    project_id: budget.projectId,
    limit: { currency: budget.currency, micros: budget.limitMicros },
    spent: { currency: budget.currency, micros: budget.spentMicros },
    reserved: { currency: budget.currency, micros: budget.reservedMicros },
    period: budget.period,
    period_start: budget.periodStart.toISOString(),
    period_end: budget.periodEnd.toISOString(),
    block_at_limit: budget.blockAtLimit,
    alert_thresholds: budget.alertThresholds,
    usage_ratio: budget.usageRatio,
  };
}

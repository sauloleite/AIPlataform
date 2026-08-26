import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { NoProject, principalOf, type AuthenticatedRequest } from '@aia/nest';
import { ForbiddenError, NotFoundError, ValidationError } from '@aia/errors';
import { CreatePat } from '../../application/use-cases/create-pat.js';
import { PAT_REPOSITORY, type PatRepository } from '../../application/ports.js';
import { createPatSchema, listQuerySchema } from './dto.schema.js';

@NoProject()
@Controller('v1/pats')
export class PatsController {
  constructor(
    private readonly createPat: CreatePat,
    @Inject(PAT_REPOSITORY) private readonly pats: PatRepository,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = createPatSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid body', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    const principal = principalOf(request);
    const isMember = principal.memberships.some((m) => m.projectId === parsed.data.project_id);
    if (!isMember) {
      throw new ForbiddenError('Cannot create a PAT for a project you do not belong to', {
        project_id: parsed.data.project_id,
      });
    }

    const result = await this.createPat.execute({
      principalId: principal.id,
      name: parsed.data.name,
      projectId: parsed.data.project_id,
      scopes: parsed.data.scopes,
      expiresInDays: parsed.data.expires_in_days,
    });

    return {
      id: result.id,
      name: result.name,
      project_id: result.projectId,
      scopes: result.scopes,
      created_at: result.createdAt.toISOString(),
      expires_at: result.expiresAt.toISOString(),
      // The only time the value appears. After this, only the hash exists.
      token: result.token,
    };
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError('Invalid pagination parameters');

    const principal = principalOf(request);
    const page = await this.pats.listByPrincipal(
      principal.id,
      parsed.data.limit,
      parsed.data.cursor,
    );

    return {
      items: page.items.map((pat) => {
        const snapshot = pat.toSnapshot();
        return {
          id: snapshot.id,
          name: snapshot.name,
          project_id: snapshot.projectId,
          scopes: snapshot.scopes.toArray(),
          created_at: snapshot.createdAt.toISOString(),
          expires_at: snapshot.expiresAt.toISOString(),
          last_used_at: snapshot.lastUsedAt?.toISOString() ?? null,
          revoked_at: snapshot.revokedAt?.toISOString() ?? null,
        };
      }),
      next_cursor: page.nextCursor,
    };
  }

  @Delete(':patId')
  @HttpCode(204)
  async revoke(@Req() request: AuthenticatedRequest, @Param('patId') patId: string): Promise<void> {
    const pat = await this.pats.findById(patId);
    // The same answer for "does not exist" and "belongs to someone else": it
    // never confirms another principal's PAT to whoever is probing.
    if (pat?.principalId !== principalOf(request).id) {
      throw new NotFoundError('PAT', patId);
    }
    pat.revoke();
    await this.pats.save(pat);
  }
}

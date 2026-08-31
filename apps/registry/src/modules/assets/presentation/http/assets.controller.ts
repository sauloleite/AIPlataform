import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { POLICY, authorize } from '@aia/auth';
import { principalOf, projectIdOf, type AuthenticatedRequest } from '@aia/nest';

import { CreateAsset } from '../../application/use-cases/create-asset.js';
import { DeprecateVersion } from '../../application/use-cases/deprecate-version.js';
import { GetAsset } from '../../application/use-cases/get-asset.js';
import { GetPublishedVersion } from '../../application/use-cases/get-published-version.js';
import { ListAssets } from '../../application/use-cases/list-assets.js';
import { PublishVersion } from '../../application/use-cases/publish-version.js';
import { UpdateDraft } from '../../application/use-cases/update-draft.js';
import { toAssetDetailResponse, toAssetResponse, toVersionResponse } from './mappers.js';
import { ASSET_KINDS, type AssetKind } from '../../domain/value-objects/index.js';
import { parseCreateAsset, parseUpdateDraft, toAssetDefinition } from './dto.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Adapts HTTP to the use cases. No business rule here. */
@Controller('v1/assets')
export class AssetsController {
  constructor(
    @Inject(CreateAsset) private readonly createAsset: CreateAsset,
    @Inject(UpdateDraft) private readonly updateDraft: UpdateDraft,
    @Inject(PublishVersion) private readonly publishVersion: PublishVersion,
    @Inject(DeprecateVersion) private readonly deprecateVersion: DeprecateVersion,
    @Inject(ListAssets) private readonly listAssets: ListAssets,
    @Inject(GetAsset) private readonly getAsset: GetAsset,
    @Inject(GetPublishedVersion) private readonly getPublished: GetPublishedVersion,
  ) {}

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    const principal = principalOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal, projectId });

    const body = parseCreateAsset(rawBody);
    return toVersionResponse(
      await this.createAsset.execute({
        projectId,
        principalId: principal.id,
        kind: body.kind,
        slug: body.slug,
        name: body.name,
        ...(body.description !== undefined && { description: body.description }),
        definition: toAssetDefinition(body.definition),
      }),
    );
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('kind') kind?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });

    const page = await this.listAssets.execute({
      projectId,
      ...(isKind(kind) && { kind }),
      limit: parseLimit(limit),
      ...(cursor !== undefined && { cursor }),
    });

    return { items: page.items.map(toAssetResponse), next_cursor: page.nextCursor };
  }

  @Get(':assetId')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return toAssetDetailResponse(await this.getAsset.execute(projectId, assetId));
  }

  @Put(':assetId/draft')
  async saveDraft(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });

    const body = parseUpdateDraft(rawBody);
    return toVersionResponse(
      await this.updateDraft.execute({
        projectId,
        assetId,
        definition: toAssetDefinition(body.definition),
        expectedVersion: body.expected_version,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
      }),
    );
  }

  @Post(':assetId/versions')
  async publish(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    const principal = principalOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal, projectId });

    return toVersionResponse(
      await this.publishVersion.execute({
        projectId,
        assetId,
        principalId: principal.id,
        accessToken: bearerOf(request),
      }),
    );
  }

  @Get(':assetId/published')
  async published(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return toVersionResponse(await this.getPublished.execute(projectId, assetId));
  }

  @Post(':assetId/versions/:version/deprecate')
  async deprecate(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });
    return toVersionResponse(await this.deprecateVersion.execute({ projectId, assetId, version }));
  }
}

/** The caller's own token, forwarded so references resolve as they would for
 *  the caller rather than as the service. */
function bearerOf(request: AuthenticatedRequest): string {
  const header = (request.headers as Record<string, unknown>)['authorization'];
  if (typeof header !== 'string') return '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function isKind(value: string | undefined): value is AssetKind {
  return value !== undefined && ASSET_KINDS.includes(value as AssetKind);
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { POLICY, authorize } from '@aia/auth';
import { principalOf, projectIdOf, type AuthenticatedRequest } from '@aia/nest';

import { CompleteDocumentUpload } from '../../application/use-cases/complete-upload.js';
import { CreateStore } from '../../application/use-cases/create-store.js';
import {
  DeleteDocument,
  DeleteStore,
  GetStore,
  ListDocuments,
  ListStores,
} from '../../application/use-cases/manage-stores.js';
import { RegisterDocument } from '../../application/use-cases/register-document.js';
import { SearchStore } from '../../application/use-cases/search-store.js';
import {
  ChangeStoreVisibility,
  ListStoreCatalogue,
  SubscribeToStore,
  UnsubscribeFromStore,
} from '../../application/use-cases/share-store.js';
import {
  parseCreateStore,
  parseRegisterDocument,
  parseSearch,
  parseVisibility,
  toAclInput,
  toChunkingInput,
} from './dto.js';
import {
  toDocumentResponse,
  toSearchHitResponse,
  toStoreResponse,
  toUploadTicketResponse,
} from './mappers.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Adapts HTTP to the use cases. No business rule here. */
@Controller('v1/stores')
export class StoresController {
  constructor(
    @Inject(CreateStore) private readonly createStore: CreateStore,
    @Inject(ListStores) private readonly listStores: ListStores,
    @Inject(GetStore) private readonly getStore: GetStore,
    @Inject(RegisterDocument) private readonly registerDocument: RegisterDocument,
    @Inject(CompleteDocumentUpload) private readonly completeUpload: CompleteDocumentUpload,
    @Inject(ListDocuments) private readonly listDocuments: ListDocuments,
    @Inject(DeleteDocument) private readonly deleteDocument: DeleteDocument,
    @Inject(DeleteStore) private readonly deleteStore: DeleteStore,
    @Inject(SearchStore) private readonly searchStore: SearchStore,
    @Inject(ChangeStoreVisibility) private readonly changeVisibility: ChangeStoreVisibility,
    @Inject(SubscribeToStore) private readonly subscribe: SubscribeToStore,
    @Inject(UnsubscribeFromStore) private readonly unsubscribe: UnsubscribeFromStore,
    @Inject(ListStoreCatalogue) private readonly catalogue: ListStoreCatalogue,
  ) {}

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });

    const body = parseCreateStore(rawBody);
    return toStoreResponse(
      await this.createStore.execute({
        projectId,
        slug: body.slug,
        name: body.name,
        ...(body.description !== undefined && { description: body.description }),
        embeddingAlias: body.embedding_alias,
        accessToken: bearerOf(request),
        chunking: toChunkingInput(body),
      }),
    );
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });

    const page = await this.listStores.execute({
      projectId,
      limit: parseLimit(limit),
      ...(cursor !== undefined && { cursor }),
    });
    return { items: page.items.map(toStoreResponse), next_cursor: page.nextCursor };
  }

  /**
   * Declared before `:storeId`, and it has to stay there.
   *
   * Nest matches routes in declaration order, so moving this below would turn
   * every catalogue request into a lookup for a store literally called
   * "catalogue" -- a 404 that looks like an empty catalogue.
   */
  @Get('catalogue')
  async listCatalogue(
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });

    const page = await this.catalogue.execute({
      projectId,
      limit: parseLimit(limit),
      ...(cursor !== undefined && { cursor }),
    });
    return { items: page.items.map(toStoreResponse), next_cursor: page.nextCursor };
  }

  @Put(':storeId/visibility')
  async setVisibility(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    // Publishing somebody else's data is an editorial act on this project's
    // assets, so it takes the same permission as editing them.
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });

    const body = parseVisibility(rawBody);
    return toStoreResponse(
      await this.changeVisibility.execute({ projectId, storeId, visibility: body.visibility }),
    );
  }

  @Put(':storeId/subscription')
  async addSubscription(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    const principal = principalOf(request);
    // Taking on somebody else's knowledge base changes what this project's
    // agents can answer with. That is an edit, not a read.
    authorize(POLICY.EDIT_ASSETS, { principal, projectId });

    return toStoreResponse(
      await this.subscribe.execute({
        projectId,
        storeId,
        principalId: principal.id,
        // The subscriber's own token: the probe has to resolve the alias under
        // THEIR policy, which is the whole point of making it.
        accessToken: bearerOf(request),
      }),
    );
  }

  @Delete(':storeId/subscription')
  @HttpCode(204)
  async removeSubscription(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
  ): Promise<void> {
    const projectId = projectIdOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });

    await this.unsubscribe.execute({ projectId, storeId });
  }

  @Get(':storeId')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });
    return toStoreResponse(await this.getStore.execute(projectId, storeId));
  }

  @Delete(':storeId')
  @HttpCode(204)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
  ): Promise<void> {
    const projectId = projectIdOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });
    await this.deleteStore.execute(projectId, storeId);
  }

  @Post(':storeId/documents')
  async register(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
    @Body() rawBody: unknown,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    const principal = principalOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal, projectId });

    const body = parseRegisterDocument(rawBody);
    return toUploadTicketResponse(
      await this.registerDocument.execute({
        projectId,
        storeId,
        principalId: principal.id,
        title: body.title,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes ?? 0,
        acl: toAclInput(body),
      }),
    );
  }

  @Post(':storeId/documents/:documentId/complete')
  @HttpCode(202)
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param('documentId') documentId: string,
  ): Promise<Record<string, unknown>> {
    const projectId = projectIdOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });

    return toDocumentResponse(
      await this.completeUpload.execute({
        projectId,
        documentId,
        accessToken: bearerOf(request),
      }),
    );
  }

  @Get(':storeId/documents')
  async documents(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const projectId = projectIdOf(request);
    authorize(POLICY.READ_PROJECT, { principal: principalOf(request), projectId });

    const page = await this.listDocuments.execute({
      projectId,
      storeId,
      limit: parseLimit(limit),
      ...(cursor !== undefined && { cursor }),
    });
    return { items: page.items.map(toDocumentResponse), next_cursor: page.nextCursor };
  }

  @Delete(':storeId/documents/:documentId')
  @HttpCode(204)
  async removeDocument(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
    @Param('documentId') documentId: string,
  ): Promise<void> {
    const projectId = projectIdOf(request);
    authorize(POLICY.EDIT_ASSETS, { principal: principalOf(request), projectId });
    await this.deleteDocument.execute(projectId, storeId, documentId);
  }

  @Post(':storeId/search')
  @HttpCode(200)
  async search(
    @Req() request: AuthenticatedRequest,
    @Param('storeId') storeId: string,
    @Body() rawBody: unknown,
  ): Promise<{ results: Record<string, unknown>[] }> {
    const projectId = projectIdOf(request);
    const principal = principalOf(request);
    authorize(POLICY.READ_PROJECT, { principal, projectId });

    const body = parseSearch(rawBody);
    const results = await this.searchStore.execute({
      projectId,
      storeId,
      principalId: principal.id,
      // Roles in this project double as the ACL groups: a document restricted
      // to `project_owner` is readable by whoever holds that role here.
      principalGroups: rolesOf(principal, projectId),
      accessToken: bearerOf(request),
      query: body.query,
      topK: body.top_k,
      mode: body.mode,
      ...(body.min_score !== undefined && { minScore: body.min_score }),
    });
    return { results: results.map(toSearchHitResponse) };
  }
}

function rolesOf(
  principal: { globalRoles: string[]; memberships: { projectId: string; roles: string[] }[] },
  projectId: string,
): string[] {
  const membership = principal.memberships.find((entry) => entry.projectId === projectId);
  return [...principal.globalRoles, ...(membership?.roles ?? [])];
}

/** The caller's own token: embeddings are charged to their project. */
function bearerOf(request: AuthenticatedRequest): string {
  const header = (request.headers as Record<string, unknown>)['authorization'];
  if (typeof header !== 'string') return '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

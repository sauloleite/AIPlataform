import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { JwtVerifier, bearerToken, type Principal } from '@aia/auth';
import { ProjectRequiredError, UnauthenticatedError } from '@aia/errors';
import { annotateActiveSpan } from '@aia/telemetry';
import { currentRequestContext } from './request-context.js';

export const JWT_VERIFIER = Symbol('JwtVerifier');

const IS_PUBLIC = 'aia:isPublic';
const SKIP_PROJECT = 'aia:skipProject';

/** Rota sem autenticacao (health, JWKS, emissao de token). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Rota autenticada que nao opera sobre um projeto (ex.: `/v1/me`). */
export const NoProject = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_PROJECT, true);

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
  projectId?: string;
}

/**
 * Valida o JWT localmente e exige o tenant.
 *
 * Nenhuma chamada de rede: as chaves publicas vem do JWKS em cache (ADR-004).
 * A ausencia de `X-Project-Id` e recusada aqui, e nao la na frente, porque
 * projeto e obrigatorio em todo contrato (doc 02, principio 2).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JWT_VERIFIER) private readonly verifier: JwtVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlers = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.verifier.verify(bearerToken(request.headers.authorization));
    request.principal = principal;

    const requestContext = currentRequestContext();
    if (requestContext !== undefined) requestContext.principal = principal;

    if (this.reflector.getAllAndOverride<boolean>(SKIP_PROJECT, handlers)) {
      annotateActiveSpan({
        projectId: '-',
        principalId: principal.id,
        principalType: principal.type,
      });
      return true;
    }

    const projectId = request.headers['x-project-id'];
    if (typeof projectId !== 'string' || projectId === '') throw new ProjectRequiredError();

    request.projectId = projectId;
    if (requestContext !== undefined) requestContext.projectId = projectId;

    annotateActiveSpan({
      projectId,
      principalId: principal.id,
      principalType: principal.type,
    });
    return true;
  }
}

/** Recupera o principal ja validado. Lanca se o guard nao rodou. */
export function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) {
    throw new UnauthenticatedError('Rota sem AuthGuard: principal ausente');
  }
  return request.principal;
}

export function projectIdOf(request: AuthenticatedRequest): string {
  if (request.projectId === undefined) throw new ProjectRequiredError();
  return request.projectId;
}

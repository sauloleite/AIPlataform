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

/** Route with no authentication (health, JWKS, token issuance). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Authenticated route that does not operate on a project, e.g. `/v1/me`. */
export const NoProject = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_PROJECT, true);

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
  projectId?: string;
}

/**
 * Validates the JWT locally and requires the tenant.
 *
 * No network call: public keys come from the cached JWKS (ADR-004). A missing
 * `X-Project-Id` is rejected here rather than further in, because project is
 * required on every contract (reference doc 02, principle 2).
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

/** Returns the already validated principal. Throws if the guard did not run. */
export function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) {
    throw new UnauthenticatedError('Route without AuthGuard: principal is missing');
  }
  return request.principal;
}

export function projectIdOf(request: AuthenticatedRequest): string {
  if (request.projectId === undefined) throw new ProjectRequiredError();
  return request.projectId;
}

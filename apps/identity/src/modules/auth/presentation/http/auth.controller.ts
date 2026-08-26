import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { NoProject, Public, principalOf, type AuthenticatedRequest } from '@aia/nest';
import { ValidationError } from '@aia/errors';
import { AuthenticateClient } from '../../application/use-cases/authenticate-client.js';
import { AuthenticateWithPassword } from '../../application/use-cases/authenticate-with-password.js';
import { IntrospectToken } from '../../application/use-cases/introspect-token.js';
import { TOKEN_SIGNER, type TokenSigner } from '../../application/ports.js';
import { CONFIG, type IdentityConfig } from '../../../../config/index.js';
import { introspectRequestSchema, tokenRequestSchema } from './dto.schema.js';

/**
 * Adapta HTTP para os casos de uso. Nenhuma regra de negocio aqui: o controller
 * so traduz entrada e saida (doc 03, secao 3.2).
 */
@Controller()
export class AuthController {
  constructor(
    private readonly authenticate: AuthenticateWithPassword,
    private readonly authenticateClient: AuthenticateClient,
    private readonly introspect: IntrospectToken,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(CONFIG) private readonly config: IdentityConfig,
  ) {}

  @Public()
  @Post('v1/auth/token')
  @HttpCode(200)
  async token(@Body() body: unknown): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  }> {
    const parsed = tokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Requisicao de token invalida', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    if (parsed.data.grant_type === 'client_credentials') {
      const issued = await this.authenticateClient.execute(
        {
          clientId: parsed.data.client_id,
          clientSecret: parsed.data.client_secret,
          ...(parsed.data.scope !== undefined && { requestedScopes: parsed.data.scope.split(' ') }),
        },
        this.config.IDENTITY_ACCESS_TOKEN_TTL,
      );
      return {
        access_token: issued.accessToken,
        token_type: issued.tokenType,
        expires_in: issued.expiresIn,
        scope: issued.scope,
      };
    }

    const result = await this.authenticate.execute(
      {
        email: parsed.data.username,
        password: parsed.data.password,
        ...(parsed.data.scope !== undefined && { requestedScopes: parsed.data.scope.split(' ') }),
      },
      this.config.IDENTITY_ACCESS_TOKEN_TTL,
    );

    return {
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      scope: result.scope,
    };
  }

  @Public()
  @Get('.well-known/jwks.json')
  async jwks(): Promise<{ keys: unknown[] }> {
    return this.signer.publicJwks();
  }

  @Public()
  @Get('.well-known/openid-configuration')
  discovery(): Record<string, unknown> {
    const issuer = this.config.IDENTITY_ISSUER;
    return {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      token_endpoint: `${issuer}/v1/auth/token`,
      introspection_endpoint: `${issuer}/v1/auth/introspect`,
      grant_types_supported: ['password'],
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['token'],
    };
  }

  @Public()
  @Post('v1/auth/introspect')
  @HttpCode(200)
  async introspectToken(@Body() body: unknown): Promise<Record<string, unknown>> {
    const parsed = introspectRequestSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('Corpo invalido');

    const result = await this.introspect.execute({ token: parsed.data.token });
    if (!result.active) return { active: false };

    return {
      active: true,
      sub: result.sub,
      scope: result.scope,
      exp: result.exp,
      project_id: result.projectId,
      principal_type: result.principalType,
    };
  }

  @NoProject()
  @Get('v1/me')
  me(@Req() request: AuthenticatedRequest): Record<string, unknown> {
    const principal = principalOf(request);
    return {
      id: principal.id,
      type: principal.type,
      email: principal.email,
      display_name: principal.displayName,
      global_roles: principal.globalRoles,
      memberships: principal.memberships.map((m) => ({
        project_id: m.projectId,
        roles: m.roles,
      })),
    };
  }
}

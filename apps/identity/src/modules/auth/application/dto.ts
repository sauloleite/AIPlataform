import type { Role } from '@aia/auth';

/**
 * Comandos e resultados dos casos de uso.
 *
 * Sao objetos simples: nada de decorators de HTTP nem de `Request` do Express
 * (doc 03, secao 3.2). A apresentacao traduz o corpo da requisicao para ca.
 */

export interface AuthenticateWithPasswordCommand {
  email: string;
  password: string;
  /** Escopos pedidos. O token nunca recebe mais do que o principal pode ter. */
  requestedScopes?: string[];
}

export interface IssuedTokenResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
}

export interface CreatePatCommand {
  principalId: string;
  name: string;
  projectId: string;
  scopes: string[];
  expiresInDays: number;
}

export interface CreatedPatResult {
  id: string;
  name: string;
  projectId: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  /** Valor em claro. Devolvido apenas nesta resposta. */
  token: string;
}

export interface IntrospectCommand {
  token: string;
}

export interface IntrospectionResult {
  active: boolean;
  sub?: string;
  scope?: string;
  exp?: number;
  projectId?: string;
  principalType?: 'user' | 'application' | 'service';
}

export interface PrincipalView {
  id: string;
  type: 'user' | 'application' | 'service';
  email?: string;
  displayName?: string;
  globalRoles: Role[];
  memberships: { projectId: string; roles: Role[] }[];
}

import type { Role } from '@aia/auth';

/**
 * Use case commands and results.
 *
 * Plain objects: no HTTP decorators and no Express `Request` (doc 03 §3.2). The
 * presentation layer translates the request body into these.
 */

export interface AuthenticateWithPasswordCommand {
  email: string;
  password: string;
  /** Requested scopes. The token never receives more than the principal may hold. */
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
  /** Plaintext value. Returned in this response only. */
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

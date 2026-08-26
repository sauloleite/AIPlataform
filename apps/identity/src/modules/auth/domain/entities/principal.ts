import type { Role } from '@aia/auth';
import { PrincipalDisabledError } from '../errors/index.js';
import { type Email } from '../value-objects/email.js';

export interface ProjectMembership {
  projectId: string;
  roles: Role[];
}

export interface PrincipalProps {
  id: string;
  type: 'user' | 'application' | 'service';
  email?: Email;
  displayName?: string;
  passwordHash?: string;
  globalRoles: Role[];
  memberships: ProjectMembership[];
  enabled: boolean;
  createdAt: Date;
}

/**
 * Quem a plataforma reconhece. Entidade: muda por metodos com nome de negocio,
 * nunca por atribuicao direta de campo.
 */
export class PrincipalEntity {
  private constructor(private props: PrincipalProps) {}

  static rehydrate(props: PrincipalProps): PrincipalEntity {
    return new PrincipalEntity(props);
  }

  static createUser(input: {
    id: string;
    email: Email;
    displayName: string;
    passwordHash: string;
    globalRoles?: Role[];
    now?: Date;
  }): PrincipalEntity {
    return new PrincipalEntity({
      id: input.id,
      type: 'user',
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      globalRoles: input.globalRoles ?? [],
      memberships: [],
      enabled: true,
      createdAt: input.now ?? new Date(),
    });
  }

  get id(): string {
    return this.props.id;
  }

  get type(): PrincipalProps['type'] {
    return this.props.type;
  }

  get email(): Email | undefined {
    return this.props.email;
  }

  get displayName(): string | undefined {
    return this.props.displayName;
  }

  get passwordHash(): string | undefined {
    return this.props.passwordHash;
  }

  get globalRoles(): readonly Role[] {
    return this.props.globalRoles;
  }

  get memberships(): readonly ProjectMembership[] {
    return this.props.memberships;
  }

  get enabled(): boolean {
    return this.props.enabled;
  }

  /** Lanca se o principal nao puder mais autenticar. */
  ensureCanAuthenticate(): void {
    if (!this.props.enabled) throw new PrincipalDisabledError(this.props.id);
  }

  rolesInProject(projectId: string): Role[] {
    const membership = this.props.memberships.find((m) => m.projectId === projectId);
    return [...this.props.globalRoles, ...(membership?.roles ?? [])];
  }

  belongsTo(projectId: string): boolean {
    return this.props.memberships.some((m) => m.projectId === projectId);
  }

  joinProject(projectId: string, roles: Role[]): void {
    const existing = this.props.memberships.find((m) => m.projectId === projectId);
    if (existing !== undefined) {
      existing.roles = [...new Set([...existing.roles, ...roles])];
      return;
    }
    this.props.memberships = [...this.props.memberships, { projectId, roles }];
  }

  leaveProject(projectId: string): void {
    this.props.memberships = this.props.memberships.filter((m) => m.projectId !== projectId);
  }

  disable(): void {
    this.props.enabled = false;
  }

  toSnapshot(): PrincipalProps {
    return { ...this.props, memberships: this.props.memberships.map((m) => ({ ...m })) };
  }
}

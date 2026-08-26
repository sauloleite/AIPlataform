import { ValidationError } from '@aia/errors';
import type { Deployment } from './deployment.js';

export type Capability = 'chat' | 'embeddings' | 'vision' | 'tools';

export interface ModelAliasProps {
  id: string;
  description?: string;
  capabilities: Capability[];
  /** Ordered by priority. The first compatible one is chosen. */
  deployments: Deployment[];
}

/**
 * The stable name a consumer uses (`chat-fast`), decoupled from the real model.
 *
 * This is what allows switching provider, version and region without touching a
 * single application.
 */
export class ModelAlias {
  private constructor(private readonly props: ModelAliasProps) {}

  static of(props: ModelAliasProps): ModelAlias {
    if (props.deployments.length === 0) {
      throw new ValidationError('An alias needs at least one deployment', { alias: props.id });
    }
    return new ModelAlias({
      ...props,
      deployments: [...props.deployments].sort((a, b) => a.priority - b.priority),
    });
  }

  get id(): string {
    return this.props.id;
  }

  get description(): string | undefined {
    return this.props.description;
  }

  get capabilities(): readonly Capability[] {
    return this.props.capabilities;
  }

  get deployments(): readonly Deployment[] {
    return this.props.deployments;
  }

  supports(capability: Capability): boolean {
    return this.props.capabilities.includes(capability);
  }

  /** Highest output ceiling across the enabled deployments. */
  maxOutputTokens(): number {
    return Math.max(
      ...this.props.deployments.filter((d) => d.enabled).map((d) => d.maxOutputTokens),
    );
  }
}

import { ValidationError } from '@aia/errors';
import type { Deployment } from './deployment.js';

export type Capability = 'chat' | 'embeddings' | 'vision' | 'tools';

export interface ModelAliasProps {
  id: string;
  description?: string;
  capabilities: Capability[];
  /** Ordenados por prioridade. O primeiro compativel e o escolhido. */
  deployments: Deployment[];
}

/**
 * Nome estavel que o consumidor usa (`chat-rapido`), desacoplado do modelo real.
 *
 * E o que permite trocar de provedor, de versao e de regiao sem tocar em nenhuma
 * aplicacao (doc 01, pontos fortes da AIA).
 */
export class ModelAlias {
  private constructor(private readonly props: ModelAliasProps) {}

  static of(props: ModelAliasProps): ModelAlias {
    if (props.deployments.length === 0) {
      throw new ValidationError('Alias precisa de pelo menos um deployment', { alias: props.id });
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

  /** Maior teto de saida entre os deployments habilitados. */
  maxOutputTokens(): number {
    return Math.max(
      ...this.props.deployments.filter((d) => d.enabled).map((d) => d.maxOutputTokens),
    );
  }
}

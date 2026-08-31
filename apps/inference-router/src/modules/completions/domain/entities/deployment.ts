import { ValidationError } from '@aia/errors';
import { Cost, type DataZone, type ProviderName } from '../value-objects/index.js';

export interface DeploymentProps {
  id: string;
  provider: ProviderName;
  /** The model name AT THE PROVIDER. Consumers never see this. */
  model: string;
  /** Where the data is processed. The basis of classification routing (ADR-010). */
  dataZone: DataZone;
  /** Lower number serves first. Ties break by declaration order. */
  priority: number;
  /** Cost per million tokens, in micros of the currency. */
  inputCostPerMillion: bigint;
  outputCostPerMillion: bigint;
  currency: string;
  maxOutputTokens: number;
  /**
   * The width of the vectors this deployment produces. Embeddings only.
   *
   * It is here because it is the one property that makes two embedding
   * deployments NOT interchangeable: a vector index is built for one width,
   * and a failover that quietly changed it would write vectors nothing can
   * search against.
   */
  dimensions?: number;
  enabled: boolean;
  /** Announced retirement. The alert fires 60 days ahead (reference doc 02 §8). */
  deprecatedAt?: Date;
}

/**
 * One concrete way to serve an alias.
 *
 * Switching provider means switching an alias's deployment: the consuming
 * application does not change a line.
 */
export class Deployment {
  constructor(private readonly props: DeploymentProps) {
    if (props.priority < 0) throw new ValidationError('Priority cannot be negative');
    if (props.maxOutputTokens < 1) throw new ValidationError('maxOutputTokens must be positive');
  }

  get dimensions(): number | undefined {
    return this.props.dimensions;
  }

  get id(): string {
    return this.props.id;
  }

  get provider(): ProviderName {
    return this.props.provider;
  }

  get model(): string {
    return this.props.model;
  }

  get dataZone(): DataZone {
    return this.props.dataZone;
  }

  get priority(): number {
    return this.props.priority;
  }

  get currency(): string {
    return this.props.currency;
  }

  get maxOutputTokens(): number {
    return this.props.maxOutputTokens;
  }

  get enabled(): boolean {
    return this.props.enabled;
  }

  get deprecatedAt(): Date | undefined {
    return this.props.deprecatedAt;
  }

  /** Is retirement 60 days away or less? The runbook trigger. */
  isNearingRetirement(now: Date, windowDays = 60): boolean {
    if (this.props.deprecatedAt === undefined) return false;
    const remainingMs = this.props.deprecatedAt.getTime() - now.getTime();
    return remainingMs <= windowDays * 24 * 60 * 60 * 1000;
  }

  /** Real cost of the call. Rounds up: never undercharge the budget. */
  costOf(promptTokens: number, completionTokens: number): Cost {
    const input = (BigInt(promptTokens) * this.props.inputCostPerMillion + 999_999n) / 1_000_000n;
    const output =
      (BigInt(completionTokens) * this.props.outputCostPerMillion + 999_999n) / 1_000_000n;
    return Cost.of(input + output, this.props.currency);
  }

  /** Effective output ceiling, respecting the deployment's own limit. */
  clampOutputTokens(requested: number | undefined): number {
    if (requested === undefined) return this.props.maxOutputTokens;
    return Math.min(requested, this.props.maxOutputTokens);
  }
}

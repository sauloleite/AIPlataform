import { ValidationError } from '@aia/errors';
import { Cost, type DataZone, type ProviderName } from '../value-objects/index.js';

export interface DeploymentProps {
  id: string;
  provider: ProviderName;
  /** Nome do modelo NO PROVEDOR. O consumidor nunca ve isto. */
  model: string;
  /** Onde o dado e processado. Base do roteamento por classificacao (ADR-010). */
  dataZone: DataZone;
  /** Menor numero atende primeiro. Empate resolve por ordem de declaracao. */
  priority: number;
  /** Custo por milhao de tokens, em micros da moeda. */
  inputCostPerMillion: bigint;
  outputCostPerMillion: bigint;
  currency: string;
  maxOutputTokens: number;
  enabled: boolean;
  /** Descontinuacao anunciada. Alerta dispara 60 dias antes (doc 02, secao 8). */
  deprecatedAt?: Date;
}

/**
 * Um jeito concreto de atender um alias.
 *
 * Trocar de provedor e trocar o deployment de um alias: a aplicacao que consome
 * nao muda uma linha.
 */
export class Deployment {
  constructor(private readonly props: DeploymentProps) {
    if (props.priority < 0) throw new ValidationError('Prioridade nao pode ser negativa');
    if (props.maxOutputTokens < 1) throw new ValidationError('maxOutputTokens deve ser positivo');
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

  /** Faltam 60 dias ou menos para a descontinuacao? Gatilho do runbook. */
  isNearingRetirement(now: Date, windowDays = 60): boolean {
    if (this.props.deprecatedAt === undefined) return false;
    const remainingMs = this.props.deprecatedAt.getTime() - now.getTime();
    return remainingMs <= windowDays * 24 * 60 * 60 * 1000;
  }

  /** Custo real da chamada. Arredonda para cima: nunca cobrar a menos do orcamento. */
  costOf(promptTokens: number, completionTokens: number): Cost {
    const input = (BigInt(promptTokens) * this.props.inputCostPerMillion + 999_999n) / 1_000_000n;
    const output =
      (BigInt(completionTokens) * this.props.outputCostPerMillion + 999_999n) / 1_000_000n;
    return Cost.of(input + output, this.props.currency);
  }

  /** Teto de saida efetivo, respeitando o limite do deployment. */
  clampOutputTokens(requested: number | undefined): number {
    if (requested === undefined) return this.props.maxOutputTokens;
    return Math.min(requested, this.props.maxOutputTokens);
  }
}

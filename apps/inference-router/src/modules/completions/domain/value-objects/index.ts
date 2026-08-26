import { ValidationError } from '@aia/errors';

export const PROVIDERS = ['openai', 'gemini', 'anthropic', 'ollama'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const DATA_ZONES = ['local', 'br', 'us', 'eu', 'global'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

export const CLASSIFICATIONS = ['publico', 'interno', 'confidencial', 'restrito'] as const;
export type DataClassification = (typeof CLASSIFICATIONS)[number];

/** Contagem de tokens. Nunca negativa; somar e a unica operacao util. */
export class TokenCount {
  private constructor(readonly value: number) {}

  static of(value: number): TokenCount {
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError('Contagem de tokens deve ser inteiro nao negativo', { value });
    }
    return new TokenCount(value);
  }

  static zero(): TokenCount {
    return new TokenCount(0);
  }

  plus(other: TokenCount): TokenCount {
    return new TokenCount(this.value + other.value);
  }
}

const MICROS_PER_UNIT = 1_000_000;

/**
 * Custo em micros da moeda.
 *
 * Inteiro por decisao: o custo de uma unica chamada e fracao de centavo, e somar
 * milhares delas em ponto flutuante deriva o suficiente para errar o orcamento.
 */
export class Cost {
  private constructor(
    readonly micros: bigint,
    readonly currency: string,
  ) {}

  static of(micros: bigint, currency: string): Cost {
    if (micros < 0n) throw new ValidationError('Custo nao pode ser negativo');
    return new Cost(micros, currency);
  }

  static zero(currency: string): Cost {
    return new Cost(0n, currency);
  }

  plus(other: Cost): Cost {
    if (this.currency !== other.currency) {
      throw new ValidationError('Nao e possivel somar custos em moedas diferentes');
    }
    return new Cost(this.micros + other.micros, this.currency);
  }

  toUnits(): number {
    return Number(this.micros) / MICROS_PER_UNIT;
  }

  toJSON(): { currency: string; micros: number } {
    return { currency: this.currency, micros: Number(this.micros) };
  }
}

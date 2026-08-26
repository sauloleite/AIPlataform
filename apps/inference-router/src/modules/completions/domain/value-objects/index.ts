import { ValidationError } from '@aia/errors';

export const PROVIDERS = ['openai', 'gemini', 'anthropic', 'ollama'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const DATA_ZONES = ['local', 'br', 'us', 'eu', 'global'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type DataClassification = (typeof CLASSIFICATIONS)[number];

/** A token count. Never negative; adding is the only useful operation. */
export class TokenCount {
  private constructor(readonly value: number) {}

  static of(value: number): TokenCount {
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError('A token count must be a non-negative integer', { value });
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
 * Cost in micros of the currency.
 *
 * Integer by decision: a single call costs a fraction of a cent, and summing
 * thousands of them in floating point drifts enough to get the budget wrong.
 */
export class Cost {
  private constructor(
    readonly micros: bigint,
    readonly currency: string,
  ) {}

  static of(micros: bigint, currency: string): Cost {
    if (micros < 0n) throw new ValidationError('Cost cannot be negative');
    return new Cost(micros, currency);
  }

  static zero(currency: string): Cost {
    return new Cost(0n, currency);
  }

  plus(other: Cost): Cost {
    if (this.currency !== other.currency) {
      throw new ValidationError('Cannot add costs in different currencies');
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

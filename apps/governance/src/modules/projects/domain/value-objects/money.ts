import { ValidationError } from '@aia/errors';

const MICROS_PER_UNIT = 1_000_000n;

/**
 * Valor monetario em micros (1 unidade = 1.000.000 micros).
 *
 * Inteiro, e nao ponto flutuante: somar milhares de custos fracionarios de
 * inferencia em `number` acumula erro, e orcamento errado vira incidente.
 */
export class Money {
  private constructor(
    readonly micros: bigint,
    readonly currency: string,
  ) {}

  static of(micros: bigint | number, currency: string): Money {
    const normalized = typeof micros === 'number' ? BigInt(Math.round(micros)) : micros;
    if (normalized < 0n) throw new ValidationError('Valor monetario nao pode ser negativo');
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationError('Moeda deve ser um codigo ISO 4217 de tres letras', { currency });
    }
    return new Money(normalized, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  static fromUnits(units: number, currency: string): Money {
    return Money.of(BigInt(Math.round(units * Number(MICROS_PER_UNIT))), currency);
  }

  private ensureSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new ValidationError('Nao e possivel operar entre moedas diferentes', {
        left: this.currency,
        right: other.currency,
      });
    }
  }

  plus(other: Money): Money {
    this.ensureSameCurrency(other);
    return new Money(this.micros + other.micros, this.currency);
  }

  minus(other: Money): Money {
    this.ensureSameCurrency(other);
    const result = this.micros - other.micros;
    return new Money(result < 0n ? 0n : result, this.currency);
  }

  isGreaterThan(other: Money): boolean {
    this.ensureSameCurrency(other);
    return this.micros > other.micros;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.ensureSameCurrency(other);
    return this.micros >= other.micros;
  }

  /** Fracao consumida, entre 0 e 1 (ou acima, se estourou). */
  ratioOf(total: Money): number {
    this.ensureSameCurrency(total);
    if (total.micros === 0n) return this.micros === 0n ? 0 : 1;
    return Number(this.micros) / Number(total.micros);
  }

  toUnits(): number {
    return Number(this.micros) / Number(MICROS_PER_UNIT);
  }

  toJSON(): { currency: string; micros: number } {
    return { currency: this.currency, micros: Number(this.micros) };
  }

  toString(): string {
    return `${this.currency} ${this.toUnits().toFixed(6)}`;
  }
}

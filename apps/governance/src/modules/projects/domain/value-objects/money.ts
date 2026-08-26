import { ValidationError } from '@aia/errors';

const MICROS_PER_UNIT = 1_000_000n;

/**
 * A monetary amount in micros (1 unit = 1,000,000 micros).
 *
 * Integer rather than floating point: summing thousands of fractional inference
 * costs in a `number` accumulates error, and a wrong budget becomes an incident.
 */
export class Money {
  private constructor(
    readonly micros: bigint,
    readonly currency: string,
  ) {}

  static of(micros: bigint | number, currency: string): Money {
    const normalized = typeof micros === 'number' ? BigInt(Math.round(micros)) : micros;
    if (normalized < 0n) throw new ValidationError('A monetary amount cannot be negative');
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationError('Currency must be a three-letter ISO 4217 code', { currency });
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
      throw new ValidationError('Cannot operate across different currencies', {
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

  /** Fraction consumed, between 0 and 1 — or above it, if the budget was blown. */
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

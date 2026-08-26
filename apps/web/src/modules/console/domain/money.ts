/**
 * Money in micros, the same representation the platform uses end to end.
 *
 * The API never sends a float: a budget of BRL 50.00 travels as 50000000
 * micros. Parsing it into a `number` at the edge would reintroduce exactly the
 * rounding error the micros representation exists to avoid, so the console
 * keeps it a `bigint` until the moment it renders.
 */
export const MICROS_PER_UNIT = 1_000_000n;

export interface MoneyJson {
  currency: string;
  micros: number | string;
}

export class Money {
  private constructor(
    readonly currency: string,
    readonly micros: bigint,
  ) {}

  static of(currency: string, micros: bigint): Money {
    if (currency.length !== 3) {
      throw new RangeError(`currency must be a 3-letter code, got "${currency}"`);
    }
    return new Money(currency.toUpperCase(), micros);
  }

  /** Reads the API shape, where `micros` may arrive as a number or a string. */
  static fromJson(value: MoneyJson): Money {
    return Money.of(value.currency, BigInt(value.micros));
  }

  static zero(currency: string): Money {
    return Money.of(currency, 0n);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.micros + other.micros);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.micros - other.micros);
  }

  /**
   * How much of `total` this amount represents, from 0 to 1.
   *
   * A zero total means "no limit set", and a project with no limit is at 0%
   * used, never at 100%: reporting a full bar for an unset budget would send
   * someone chasing a problem that does not exist.
   */
  ratioOf(total: Money): number {
    this.assertSameCurrency(total);
    if (total.micros === 0n) return 0;
    return Number(this.micros) / Number(total.micros);
  }

  get isZero(): boolean {
    return this.micros === 0n;
  }

  /**
   * Formats for display.
   *
   * Built by hand rather than through `Intl.NumberFormat`, because the value is
   * a bigint: handing it to `Intl` means converting to `number` first, which is
   * the rounding this representation exists to avoid.
   */
  format(): string {
    const negative = this.micros < 0n;
    const absolute = negative ? -this.micros : this.micros;
    const units = absolute / MICROS_PER_UNIT;
    const fraction = absolute % MICROS_PER_UNIT;

    // Two decimals are enough for a balance; a cost below one cent shows more
    // so an operator can still tell a cheap call from a free one.
    const decimals = units === 0n && fraction > 0n && fraction < 10_000n ? 6 : 2;
    const scaled = fraction / 10n ** BigInt(6 - decimals);
    const body = `${units.toString()}.${scaled.toString().padStart(decimals, '0')}`;

    return `${negative ? '-' : ''}${this.currency} ${body}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new RangeError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}

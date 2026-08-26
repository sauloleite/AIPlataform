import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { Money } from '../src/modules/projects/domain/value-objects/money.js';

describe('Money', () => {
  it('soma milhares de custos fracionarios sem acumular erro', () => {
    // 10.000 chamadas a R$ 0,000123 cada. Em ponto flutuante isso deriva.
    let total = Money.zero('BRL');
    const unit = Money.of(123n, 'BRL');
    for (let i = 0; i < 10_000; i += 1) total = total.plus(unit);

    expect(total.micros).toBe(1_230_000n);
    expect(total.toUnits()).toBe(1.23);
  });

  it('converte unidades para micros', () => {
    expect(Money.fromUnits(1.5, 'BRL').micros).toBe(1_500_000n);
  });

  it('minus nunca fica negativo: orcamento restante zerado, nao devedor', () => {
    expect(Money.of(100n, 'BRL').minus(Money.of(500n, 'BRL')).micros).toBe(0n);
  });

  it('recusa operacao entre moedas diferentes', () => {
    expect(() => Money.of(100n, 'BRL').plus(Money.of(100n, 'USD'))).toThrow(ValidationError);
  });

  it('recusa valor negativo e moeda invalida', () => {
    expect(() => Money.of(-1n, 'BRL')).toThrow(ValidationError);
    expect(() => Money.of(1n, 'brl')).toThrow(ValidationError);
    expect(() => Money.of(1n, 'REAL')).toThrow(ValidationError);
  });

  it('ratioOf trata limite zero como totalmente consumido', () => {
    expect(Money.of(1n, 'BRL').ratioOf(Money.zero('BRL'))).toBe(1);
    expect(Money.zero('BRL').ratioOf(Money.zero('BRL'))).toBe(0);
  });
});

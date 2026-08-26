import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { Budget, BudgetExhaustedError } from '../src/modules/projects/domain/entities/budget.js';
import { Money } from '../src/modules/projects/domain/value-objects/money.js';

const NOW = new Date('2026-03-15T10:00:00Z');
const budget = (overrides: Partial<Parameters<typeof Budget.create>[0]> = {}): Budget =>
  Budget.create({
    projectId: 'proj-1',
    limit: Money.fromUnits(100, 'BRL'),
    period: 'monthly',
    now: NOW,
    ...overrides,
  });

describe('Budget', () => {
  it('comeca zerado e com o periodo alinhado ao inicio do mes', () => {
    const b = budget();
    expect(b.spent.micros).toBe(0n);
    expect(b.periodStart.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(b.periodEnd().toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('periodo diario vira a meia-noite UTC', () => {
    const b = budget({ period: 'daily' });
    expect(b.periodStart.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(b.periodEnd().toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('committed soma gasto e reservado, para nao autorizar duas vezes o mesmo saldo', () => {
    const b = Budget.rehydrate({
      projectId: 'proj-1',
      limit: Money.fromUnits(100, 'BRL'),
      spent: Money.fromUnits(60, 'BRL'),
      reserved: Money.fromUnits(30, 'BRL'),
      period: 'monthly',
      periodStart: NOW,
      blockAtLimit: true,
      alertThresholds: [0.8],
    });

    expect(b.committed().toUnits()).toBe(90);
    expect(b.remaining().toUnits()).toBe(10);
    expect(b.usageRatio()).toBeCloseTo(0.9);
  });

  it('recusa gasto que ultrapassa o limite quando bloqueia', () => {
    const b = Budget.rehydrate({
      projectId: 'proj-1',
      limit: Money.fromUnits(10, 'BRL'),
      spent: Money.fromUnits(9, 'BRL'),
      reserved: Money.zero('BRL'),
      period: 'monthly',
      periodStart: NOW,
      blockAtLimit: true,
      alertThresholds: [],
    });

    expect(() => {
      b.ensureCanAfford(Money.fromUnits(0.5, 'BRL'), NOW);
    }).not.toThrow();
    expect(() => {
      b.ensureCanAfford(Money.fromUnits(2, 'BRL'), NOW);
    }).toThrow(BudgetExhaustedError);
  });

  it('o erro de orcamento diz quando vale a pena tentar de novo', () => {
    const b = Budget.rehydrate({
      projectId: 'proj-1',
      limit: Money.zero('BRL'),
      spent: Money.zero('BRL'),
      reserved: Money.zero('BRL'),
      period: 'daily',
      periodStart: new Date('2026-03-15T00:00:00Z'),
      blockAtLimit: true,
      alertThresholds: [],
    });

    try {
      b.ensureCanAfford(Money.of(1n, 'BRL'), NOW);
      expect.unreachable('deveria ter lancado');
    } catch (error) {
      // Faltam 14 h para a virada do periodo diario.
      expect((error as BudgetExhaustedError).details['retry_after']).toBe(14 * 60 * 60);
    }
  });

  it('projeto que nao bloqueia no limite continua atendendo e so alerta', () => {
    const b = Budget.rehydrate({
      projectId: 'proj-1',
      limit: Money.fromUnits(1, 'BRL'),
      spent: Money.fromUnits(100, 'BRL'),
      reserved: Money.zero('BRL'),
      period: 'monthly',
      periodStart: NOW,
      blockAtLimit: false,
      alertThresholds: [1],
    });

    expect(() => {
      b.ensureCanAfford(Money.fromUnits(50, 'BRL'), NOW);
    }).not.toThrow();
  });

  it('a virada do periodo zera o gasto', () => {
    const b = budget({ period: 'daily' });
    const later = new Date('2026-03-16T00:00:01Z');

    expect(b.isExpired(later)).toBe(true);
    b.rollOver(later);
    expect(b.spent.micros).toBe(0n);
    expect(b.periodStart.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('crossedThresholds dispara so na travessia, nao a cada chamada', () => {
    const b = Budget.rehydrate({
      projectId: 'proj-1',
      limit: Money.fromUnits(100, 'BRL'),
      spent: Money.fromUnits(85, 'BRL'),
      reserved: Money.zero('BRL'),
      period: 'monthly',
      periodStart: NOW,
      blockAtLimit: true,
      alertThresholds: [0.5, 0.8, 1.0],
    });

    expect(b.crossedThresholds(0.79)).toEqual([0.8]);
    expect(b.crossedThresholds(0.85)).toEqual([]);
    expect(b.crossedThresholds(0.1)).toEqual([0.5, 0.8]);
  });

  it('recusa trocar a moeda de um orcamento em uso', () => {
    expect(() => {
      budget().changeLimit(Money.fromUnits(100, 'USD'));
    }).toThrow(ValidationError);
  });

  it('recusa limiar de alerta fora da faixa', () => {
    expect(() => budget({ alertThresholds: [0, 0.5] })).toThrow(ValidationError);
    expect(() => budget({ alertThresholds: [3] })).toThrow(ValidationError);
  });
});

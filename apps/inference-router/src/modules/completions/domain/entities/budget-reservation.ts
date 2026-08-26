import { ValidationError } from '@aia/errors';
import { Cost } from '../value-objects/index.js';

export type ReservationState = 'held' | 'committed' | 'released';

/**
 * Reserva de orcamento.
 *
 * Uma chamada de inferencia custa o que so se sabe DEPOIS de terminar. Reservar
 * uma estimativa antes e comitar o real depois evita que N chamadas simultaneas
 * autorizem cada uma o mesmo saldo (doc 02, fluxo 7.1).
 */
export class BudgetReservation {
  private constructor(
    readonly id: string,
    readonly projectId: string,
    readonly estimated: Cost,
    /** Identifica o periodo orcamentario (ex.: `2026-03`). */
    readonly periodKey: string,
    private stateValue: ReservationState,
    private actualValue?: Cost,
  ) {}

  static held(input: {
    id: string;
    projectId: string;
    estimated: Cost;
    periodKey: string;
  }): BudgetReservation {
    return new BudgetReservation(
      input.id,
      input.projectId,
      input.estimated,
      input.periodKey,
      'held',
    );
  }

  /**
   * Reserva simbolica de quando o Redis esta indisponivel.
   *
   * O request e atendido sob um teto conservador e marcado para reconciliacao,
   * em vez de derrubar toda a inferencia por causa do cache (doc 02, secao 8).
   */
  static unverified(projectId: string, currency: string): BudgetReservation {
    return new BudgetReservation('unverified', projectId, Cost.zero(currency), '-', 'committed');
  }

  get state(): ReservationState {
    return this.stateValue;
  }

  get actual(): Cost | undefined {
    return this.actualValue;
  }

  get isUnverified(): boolean {
    return this.id === 'unverified';
  }

  commit(actual: Cost): void {
    if (this.stateValue === 'released') {
      throw new ValidationError('Reserva ja liberada nao pode ser comitada', { id: this.id });
    }
    this.stateValue = 'committed';
    this.actualValue = actual;
  }

  release(): void {
    // Liberar duas vezes precisa ser inofensivo: a compensacao roda no `finally`
    // e pode coincidir com um erro tardio.
    if (this.stateValue === 'committed') return;
    this.stateValue = 'released';
  }
}

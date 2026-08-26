import { ValidationError } from '@aia/errors';
import { Cost } from '../value-objects/index.js';

export type ReservationState = 'held' | 'committed' | 'released';

/**
 * A budget reservation.
 *
 * An inference call costs what is only known AFTER it finishes. Reserving an
 * estimate first and committing the real amount afterwards keeps N concurrent
 * calls from each authorising the same balance (reference doc 02, flow 7.1).
 */
export class BudgetReservation {
  private constructor(
    readonly id: string,
    readonly projectId: string,
    readonly estimated: Cost,
    /** Identifies the budget period, e.g. `2026-03`. */
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
   * Token reservation used when Redis is unreachable.
   *
   * The request is served under a conservative ceiling and flagged for later
   * reconciliation, rather than taking all inference down because of the cache
   * (reference doc 02 §8).
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
      throw new ValidationError('A released reservation cannot be committed', { id: this.id });
    }
    this.stateValue = 'committed';
    this.actualValue = actual;
  }

  release(): void {
    // Releasing twice has to be harmless: the compensation runs in a `finally`
    // and may coincide with a late error.
    if (this.stateValue === 'committed') return;
    this.stateValue = 'released';
  }
}

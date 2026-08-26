import { DomainError, ERROR_CODES, ValidationError, type ErrorCode } from '@aia/errors';
import { Money } from '../value-objects/money.js';

export type BudgetPeriod = 'daily' | 'monthly';

export class BudgetExhaustedError extends DomainError {
  readonly code: ErrorCode = ERROR_CODES.BUDGET_EXHAUSTED;
  readonly status = 429;
  override readonly retryable = true;

  constructor(projectId: string, retryAfterSeconds: number) {
    super('Project budget exhausted for the period', {
      project_id: projectId,
      retry_after: retryAfterSeconds,
    });
  }
}

export interface BudgetProps {
  projectId: string;
  limit: Money;
  spent: Money;
  reserved: Money;
  period: BudgetPeriod;
  periodStart: Date;
  blockAtLimit: boolean;
  alertThresholds: number[];
}

/**
 * Budget in CURRENCY, not in tokens.
 *
 * Cost per token varies by provider and by model; what the business controls is
 * spend (reference doc 01, finding 3.3). Converting tokens to currency happens
 * in the router, which knows each deployment's price table.
 */
export class Budget {
  private constructor(private props: BudgetProps) {}

  static rehydrate(props: BudgetProps): Budget {
    return new Budget(props);
  }

  static create(input: {
    projectId: string;
    limit: Money;
    period: BudgetPeriod;
    blockAtLimit?: boolean;
    alertThresholds?: number[];
    now?: Date;
  }): Budget {
    const thresholds = input.alertThresholds ?? [0.5, 0.8, 1.0];
    if (thresholds.some((threshold) => threshold <= 0 || threshold > 2)) {
      throw new ValidationError('An alert threshold must sit between 0 and 2', {
        thresholds,
      });
    }

    return new Budget({
      projectId: input.projectId,
      limit: input.limit,
      spent: Money.zero(input.limit.currency),
      reserved: Money.zero(input.limit.currency),
      period: input.period,
      periodStart: Budget.startOfPeriod(input.period, input.now ?? new Date()),
      blockAtLimit: input.blockAtLimit ?? true,
      alertThresholds: [...thresholds].sort((a, b) => a - b),
    });
  }

  static startOfPeriod(period: BudgetPeriod, now: Date): Date {
    return period === 'daily'
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  get projectId(): string {
    return this.props.projectId;
  }

  get limit(): Money {
    return this.props.limit;
  }

  get spent(): Money {
    return this.props.spent;
  }

  get reserved(): Money {
    return this.props.reserved;
  }

  get period(): BudgetPeriod {
    return this.props.period;
  }

  get periodStart(): Date {
    return this.props.periodStart;
  }

  get blockAtLimit(): boolean {
    return this.props.blockAtLimit;
  }

  get alertThresholds(): readonly number[] {
    return this.props.alertThresholds;
  }

  periodEnd(): Date {
    const start = this.props.periodStart;
    return this.props.period === 'daily'
      ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }

  /** Spend plus whatever is reserved by calls in flight. */
  committed(): Money {
    return this.props.spent.plus(this.props.reserved);
  }

  remaining(): Money {
    return this.props.limit.minus(this.committed());
  }

  usageRatio(): number {
    return this.committed().ratioOf(this.props.limit);
  }

  /**
   * Has the period rolled over? The caller decides to reset; the entity never
   * reads the clock itself, so it stays deterministic in tests.
   */
  isExpired(now: Date): boolean {
    return now.getTime() >= this.periodEnd().getTime();
  }

  rollOver(now: Date): void {
    this.props.periodStart = Budget.startOfPeriod(this.props.period, now);
    this.props.spent = Money.zero(this.props.limit.currency);
    this.props.reserved = Money.zero(this.props.limit.currency);
  }

  /** Throws if the estimate does not fit and the project blocks at its limit. */
  ensureCanAfford(estimated: Money, now: Date): void {
    if (!this.props.blockAtLimit) return;
    if (this.committed().plus(estimated).isGreaterThan(this.props.limit)) {
      const retryAfter = Math.max(
        1,
        Math.ceil((this.periodEnd().getTime() - now.getTime()) / 1000),
      );
      throw new BudgetExhaustedError(this.props.projectId, retryAfter);
    }
  }

  changeLimit(limit: Money): void {
    if (limit.currency !== this.props.limit.currency) {
      // Switching currency would invalidate the spend already accrued this period.
      throw new ValidationError('Cannot change the currency of a budget in use', {
        current: this.props.limit.currency,
        requested: limit.currency,
      });
    }
    this.props.limit = limit;
  }

  changePolicy(input: { blockAtLimit?: boolean; alertThresholds?: number[] }): void {
    if (input.blockAtLimit !== undefined) this.props.blockAtLimit = input.blockAtLimit;
    if (input.alertThresholds !== undefined) {
      this.props.alertThresholds = [...input.alertThresholds].sort((a, b) => a - b);
    }
  }

  /** Thresholds the current ratio just crossed relative to the previous one. */
  crossedThresholds(previousRatio: number): number[] {
    const current = this.usageRatio();
    return this.props.alertThresholds.filter(
      (threshold) => previousRatio < threshold && current >= threshold,
    );
  }

  toSnapshot(): BudgetProps {
    return { ...this.props, alertThresholds: [...this.props.alertThresholds] };
  }
}

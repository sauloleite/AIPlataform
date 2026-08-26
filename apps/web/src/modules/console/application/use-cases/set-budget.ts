import { MICROS_PER_UNIT, Money } from '../../domain/money';
import { PlatformError } from '../../domain/errors';
import type { BudgetSnapshot, PlatformGateway } from '../ports';

export interface SetBudgetInput {
  /** What a person typed, e.g. "50" or "50.75". Never a float from the wire. */
  amount: string;
  currency: string;
  period: 'daily' | 'monthly';
  blockAtLimit: boolean;
}

/**
 * Sets a project's budget for the period.
 *
 * The amount is parsed from the typed string straight into micros. Going
 * through `Number` first would round "0.1" before it ever reached the platform,
 * which is the whole reason budgets are integers here.
 */
export class SetBudget {
  constructor(private readonly platform: PlatformGateway) {}

  async execute(
    accessToken: string,
    projectId: string,
    input: SetBudgetInput,
  ): Promise<BudgetSnapshot> {
    const micros = parseAmountToMicros(input.amount);
    const limit = Money.of(input.currency, micros);

    return this.platform.setBudget(accessToken, projectId, {
      currency: limit.currency,
      micros: limit.micros.toString(),
      period: input.period,
      blockAtLimit: input.blockAtLimit,
    });
  }
}

/**
 * "50.75" becomes 50750000 micros, with no float in between.
 *
 * More than six decimals is rejected rather than silently truncated: quietly
 * dropping a digit from a budget is the kind of bug nobody notices until the
 * invoice.
 */
export function parseAmountToMicros(amount: string): bigint {
  const trimmed = amount.trim();
  const match = /^(\d+)(?:[.,](\d{1,6}))?$/.exec(trimmed);

  if (match === null) {
    throw new PlatformError({
      type: 'https://aia.dev/errors/validation_failed',
      title: 'Invalid request',
      status: 400,
      detail: `"${amount}" is not a valid amount. Use digits with up to six decimals.`,
      code: 'validation_failed',
    });
  }

  const [, units = '0', fraction = ''] = match;
  return BigInt(units) * MICROS_PER_UNIT + BigInt(fraction.padEnd(6, '0'));
}

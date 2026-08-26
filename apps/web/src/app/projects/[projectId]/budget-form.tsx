'use client';

import type { ReactElement } from 'react';
import { useActionState } from 'react';

import { setBudgetAction, type ActionResult } from '../../actions';

const EMPTY: ActionResult = {};

export function BudgetForm({
  projectId,
  amount,
  currency,
  period,
  blockAtLimit,
}: {
  projectId: string;
  amount: string;
  currency: string;
  period: 'daily' | 'monthly';
  blockAtLimit: boolean;
}): ReactElement {
  const [state, action, pending] = useActionState(setBudgetAction, EMPTY);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />

      {state.error !== undefined && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}

      <div className="row">
        <label className="field">
          <span>Limit</span>
          {/* Text, not number: the value is parsed into integer micros, and a
              number input would hand over a float that has already rounded. */}
          <input name="amount" type="text" inputMode="decimal" defaultValue={amount} required />
        </label>
        <label className="field">
          <span>Currency</span>
          <input name="currency" defaultValue={currency} maxLength={3} required />
        </label>
        <label className="field">
          <span>Period</span>
          <select name="period" defaultValue={period}>
            <option value="monthly">monthly</option>
            <option value="daily">daily</option>
          </select>
        </label>
      </div>

      <label className="checkbox">
        <input type="checkbox" name="blockAtLimit" defaultChecked={blockAtLimit} />
        Refuse new calls once the limit is reached
      </label>

      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save budget'}
      </button>
    </form>
  );
}

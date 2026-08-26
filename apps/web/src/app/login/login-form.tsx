'use client';

import type { ReactElement } from 'react';
import { useActionState } from 'react';

import { signInAction, type ActionResult } from '../actions';

const EMPTY: ActionResult = {};

export function LoginForm(): ReactElement {
  const [state, action, pending] = useActionState(signInAction, EMPTY);

  return (
    <form action={action}>
      {state.error !== undefined && (
        <p className="notice error" role="alert">
          {state.error}
        </p>
      )}

      <label className="field">
        <span>Email</span>
        <input name="username" type="email" autoComplete="username" required />
      </label>

      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>

      <button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

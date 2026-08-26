'use client';

import type { ReactElement } from 'react';
import { signOutAction } from './actions';

export function SignOutButton(): ReactElement {
  return (
    <form action={signOutAction}>
      <button className="secondary" type="submit">
        Sign out
      </button>
    </form>
  );
}

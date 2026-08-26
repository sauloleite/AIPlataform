import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { getContainer } from '../../container';
import { LoginForm } from './login-form';

export default async function LoginPage(): Promise<ReactElement> {
  const { sessions } = await getContainer();
  if ((await sessions.read()) !== null) redirect('/');

  return (
    <div style={{ maxWidth: 380, margin: '48px auto' }}>
      <h1>Sign in</h1>
      <p className="lede">
        The console signs in against <code>aia-identity</code>, which mints its own token. No cloud
        identity provider is involved.
      </p>
      <div className="card">
        <LoginForm />
      </div>
    </div>
  );
}

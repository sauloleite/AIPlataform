import { isExpired } from '../../domain/session';
import { PlatformError } from '../../domain/errors';
import type { Clock, SessionStore } from '../ports';
import type { Session } from '../../domain/session';

/**
 * Resolves the current session, or refuses.
 *
 * Every console operation starts here, so the "no session" path exists in one
 * place instead of being re-derived in each route handler. An expired session is
 * cleared rather than merely rejected: leaving a dead cookie in the browser
 * produces a user who looks signed in and gets 401s.
 */
export class AuthorizeRequest {
  constructor(
    private readonly sessions: SessionStore,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<{ session: Session; accessToken: string }> {
    const session = await this.sessions.read();
    const accessToken = await this.sessions.readToken();

    if (session === null || accessToken === null) {
      throw unauthenticated('No active session');
    }

    if (isExpired(session, this.clock.nowSeconds())) {
      await this.sessions.clear();
      throw unauthenticated('The session has expired');
    }

    return { session, accessToken };
  }
}

function unauthenticated(detail: string): PlatformError {
  return new PlatformError({
    type: 'https://aia.dev/errors/unauthenticated',
    title: 'Not authenticated',
    status: 401,
    detail,
    code: 'unauthenticated',
  });
}

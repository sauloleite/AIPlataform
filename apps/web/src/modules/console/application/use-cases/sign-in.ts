import type { Clock, PlatformGateway, SessionStore } from '../ports';
import type { Session } from '../../domain/session';

/**
 * Exchanges credentials for a session.
 *
 * The access token goes to the SessionStore and is never returned to the
 * caller. That is deliberate: the caller here is a Next.js route handler, and a
 * token it holds is a token one careless `return` away from the browser.
 */
export class SignIn {
  constructor(
    private readonly platform: PlatformGateway,
    private readonly sessions: SessionStore,
    private readonly clock: Clock,
  ) {}

  async execute(username: string, password: string): Promise<Session> {
    const { accessToken, expiresIn } = await this.platform.signIn(username, password);
    const principal = await this.platform.currentPrincipal(accessToken);

    const session: Session = {
      principal,
      expiresAt: this.clock.nowSeconds() + expiresIn,
    };

    await this.sessions.write(session, accessToken);
    return session;
  }
}

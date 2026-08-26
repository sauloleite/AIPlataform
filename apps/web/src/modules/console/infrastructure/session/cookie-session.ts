import type { Session } from '../../domain/session';
import type { SessionStore } from '../../application/ports';

/**
 * The session in httpOnly cookies.
 *
 * The access token goes into a cookie the browser cannot read. That is the
 * whole point of the BFF: a token in `localStorage` is readable by any script
 * that gets injected, and one XSS then becomes a stolen platform credential
 * that works from anywhere. An httpOnly cookie can be sent by the browser but
 * never read by it, so an injected script can at most act as the user while
 * they are on the page.
 *
 * Two cookies rather than one: the token is opaque and never leaves the server,
 * while the principal is readable by the server's own rendering. Splitting them
 * keeps the token out of every code path that only needs a display name.
 */
const TOKEN_COOKIE = 'aia_token';
const SESSION_COOKIE = 'aia_session';

export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: CookieOptions): void;
  delete(name: string): void;
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge?: number;
}

export class CookieSessionStore implements SessionStore {
  constructor(
    private readonly jar: CookieJar,
    private readonly secure: boolean,
  ) {}

  read(): Promise<Session | null> {
    const raw = this.jar.get(SESSION_COOKIE)?.value;
    if (raw === undefined) return Promise.resolve(null);

    try {
      return Promise.resolve(JSON.parse(decode(raw)) as Session);
    } catch {
      // A tampered or truncated cookie is treated as no session at all. Trying
      // to salvage it would mean trusting a value the browser could edit.
      return Promise.resolve(null);
    }
  }

  readToken(): Promise<string | null> {
    return Promise.resolve(this.jar.get(TOKEN_COOKIE)?.value ?? null);
  }

  write(session: Session, accessToken: string): Promise<void> {
    const maxAge = Math.max(0, session.expiresAt - Math.floor(Date.now() / 1000));

    this.jar.set(TOKEN_COOKIE, accessToken, this.options(maxAge));
    this.jar.set(SESSION_COOKIE, encode(JSON.stringify(session)), this.options(maxAge));
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.jar.delete(TOKEN_COOKIE);
    this.jar.delete(SESSION_COOKIE);
    return Promise.resolve();
  }

  private options(maxAge: number): CookieOptions {
    return {
      httpOnly: true,
      // Only over HTTPS in production. Forced on in development too would break
      // http://localhost, where there is no certificate to speak of.
      secure: this.secure,
      // `lax` still sends the cookie on a top-level navigation, which is what
      // makes a bookmarked project page work, while keeping it off cross-site
      // POSTs — the CSRF vector that matters here.
      sameSite: 'lax',
      path: '/',
      maxAge,
    };
  }
}

// Base64url so the JSON survives a cookie value without needing quoting rules.
function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

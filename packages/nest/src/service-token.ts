import { Injectable, Logger } from '@nestjs/common';

export interface ServiceTokenOptions {
  identityUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * The router's own credential for talking to governance and guardrails.
 *
 * It replaces the managed identity a cloud would provide (reference doc 02 §6
 * and ADR-012): the router authenticates against `aia-identity` through the
 * `client_credentials` grant and reuses the token until it is close to expiry.
 *
 * The token is refreshed BEFORE it expires, with a margin: refreshing at the
 * exact moment of expiry would fail an in-flight request over clock skew.
 *
 * A refresh in progress is shared by every concurrent caller; without that, a
 * simultaneous spike would fire dozens of identical logins.
 */
@Injectable()
export class ServiceTokenProvider {
  private static readonly REFRESH_MARGIN_MS = 60_000;

  private readonly logger = new Logger(ServiceTokenProvider.name);
  private token?: string;
  private expiresAt = 0;
  private inFlight?: Promise<string>;

  constructor(private readonly options: ServiceTokenOptions) {}

  get configured(): boolean {
    return this.options.clientId !== '' && this.options.clientSecret !== '';
  }

  async get(): Promise<string> {
    if (!this.configured) return '';

    if (this.token !== undefined && Date.now() < this.expiresAt) return this.token;
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Discards the current token. Called when a dependency returns 401. */
  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
  }

  private async fetchToken(): Promise<string> {
    const response = await fetch(`${this.options.identityUrl}/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        ...(this.options.scope !== undefined && { scope: this.options.scope }),
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `could not obtain a service token (${response.status.toString()}): ${body.slice(0, 200)}`,
      );
      throw new Error(
        `identity responded ${response.status.toString()} when issuing a service token`,
      );
    }

    const payload = (await response.json()) as TokenResponse;
    this.token = payload.access_token;
    this.expiresAt =
      Date.now() + payload.expires_in * 1000 - ServiceTokenProvider.REFRESH_MARGIN_MS;

    this.logger.log(`service token obtained, valid for ${payload.expires_in.toString()}s`);
    return this.token;
  }
}

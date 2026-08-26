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
 * Credencial do proprio router para falar com governance e guardrails.
 *
 * Substitui a identidade gerenciada que uma nuvem forneceria (doc 02, secao 6 e
 * ADR-012): o router se autentica no `aia-identity` pelo grant
 * `client_credentials` e reusa o token ate perto do vencimento.
 *
 * O token e renovado ANTES de expirar, com uma margem: renovar no momento exato
 * do vencimento faria a requisicao em voo falhar por diferenca de relogio.
 *
 * Uma renovacao em curso e compartilhada por todas as chamadas concorrentes;
 * sem isso, um pico simultaneo dispararia dezenas de logins iguais.
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

  /** Descarta o token atual. Chamado quando uma dependencia devolve 401. */
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
        `nao foi possivel obter token de servico (${response.status.toString()}): ${body.slice(0, 200)}`,
      );
      throw new Error(
        `identity respondeu ${response.status.toString()} ao emitir token de servico`,
      );
    }

    const payload = (await response.json()) as TokenResponse;
    this.token = payload.access_token;
    this.expiresAt =
      Date.now() + payload.expires_in * 1000 - ServiceTokenProvider.REFRESH_MARGIN_MS;

    this.logger.log(`token de servico obtido, valido por ${payload.expires_in.toString()}s`);
    return this.token;
  }
}

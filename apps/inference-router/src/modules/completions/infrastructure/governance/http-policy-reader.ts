import { Injectable, Logger } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';
import { NotFoundError } from '@aia/errors';
import type { PolicyReader, PolicyResult } from '../../application/ports.js';
import type { ProjectPolicySnapshot } from '../../domain/services/model-selection-policy.js';
import type { DataClassification, DataZone } from '../../domain/value-objects/index.js';

interface PolicyResponse {
  project_id: string;
  data_classification: DataClassification;
  allowed_data_zones: DataZone[];
  model_rules?: { alias: string; allowed: boolean; max_output_tokens?: number }[];
  max_concurrent_requests: number;
  content_capture: boolean;
  version: number;
  budget?: {
    currency: string;
    limit_micros: number;
    spent_micros: number;
    reserved_micros: number;
    block_at_limit: boolean;
    period_end: string;
  };
}

interface CacheEntry {
  value: PolicyResult;
  expiresAt: number;
}

export interface HttpPolicyReaderOptions {
  governanceUrl: string;
  /** Token de servico. O router chama o governance como servico, nao como usuario. */
  serviceToken: () => Promise<string>;
  cacheTtlSeconds: number;
  defaultCurrency: string;
  /** Limite implicito quando o projeto nao tem orcamento configurado. */
  unlimitedMicros?: bigint;
}

/**
 * Politica do projeto com cache local e degradacao graciosa.
 *
 * Este e o endpoint mais chamado da plataforma: uma ida ao governance por
 * requisicao de inferencia colocaria um servico de controle no caminho critico.
 * O cache com TTL curto resolve isso.
 *
 * Quando o governance cai, a ultima politica conhecida continua valendo e a
 * resposta e marcada com `policy_stale=true` (doc 02, secao 8). Recusar toda a
 * inferencia porque o servico de politicas reiniciou seria trocar um risco
 * pequeno por uma indisponibilidade completa.
 */
@Injectable()
export class HttpPolicyReader implements PolicyReader {
  private readonly logger = new Logger(HttpPolicyReader.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly executor = new ResilienceExecutor(POLICIES.INTERNAL);

  constructor(private readonly options: HttpPolicyReaderOptions) {}

  /** Chamado pelo consumidor de `PolicyChanged`, para invalidar antes do TTL. */
  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  async forProject(projectId: string): Promise<PolicyResult> {
    const cached = this.cache.get(projectId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;

    try {
      const fresh = await this.fetchPolicy(projectId);
      this.cache.set(projectId, {
        value: fresh,
        expiresAt: Date.now() + this.options.cacheTtlSeconds * 1000,
      });
      return fresh;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;

      if (cached !== undefined) {
        this.logger.warn(
          `governance indisponivel (${describe(error)}); usando politica em cache para ${projectId}`,
        );
        // Estende o cache vencido: sem isso, cada request repetiria a falha.
        const stale: PolicyResult = { ...cached.value, stale: true };
        this.cache.set(projectId, { value: stale, expiresAt: Date.now() + 10_000 });
        return stale;
      }

      throw error;
    }
  }

  private async fetchPolicy(projectId: string): Promise<PolicyResult> {
    const token = await this.options.serviceToken();

    const response = await this.executor.execute(
      (signal) =>
        fetch(`${this.options.governanceUrl}/v1/projects/${projectId}/policy`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal,
        }),
      { key: 'governance' },
    );

    if (response.status === 404) throw new NotFoundError('Projeto', projectId);
    if (!response.ok) {
      throw new Error(`governance respondeu ${response.status.toString()}`);
    }

    return toPolicyResult((await response.json()) as PolicyResponse, this.options);
  }
}

/** `2026-03` para orcamento mensal, `2026-03-15` para diario. */
export function periodKeyFrom(periodEnd: Date, period: 'daily' | 'monthly'): string {
  const year = periodEnd.getUTCFullYear().toString();
  const month = (periodEnd.getUTCMonth() + 1).toString().padStart(2, '0');
  if (period === 'monthly') return `${year}-${month}`;
  return `${year}-${month}-${periodEnd.getUTCDate().toString().padStart(2, '0')}`;
}

const UNLIMITED_MICROS = 9_223_372_036_854_775_807n;

function toPolicyResult(payload: PolicyResponse, options: HttpPolicyReaderOptions): PolicyResult {
  const rules = payload.model_rules ?? [];
  const snapshot: ProjectPolicySnapshot = {
    projectId: payload.project_id,
    classification: payload.data_classification,
    allowedZones: payload.allowed_data_zones,
    isAliasAllowed: (alias) => rules.find((rule) => rule.alias === alias)?.allowed ?? true,
    maxOutputTokensFor: (alias) => rules.find((rule) => rule.alias === alias)?.max_output_tokens,
  };

  const budget = payload.budget;
  if (budget === undefined) {
    // Projeto sem orcamento configurado nao e bloqueado: a governanca decide
    // quando exigir orcamento, o router so aplica o que existe.
    return {
      policy: snapshot,
      limitMicros: options.unlimitedMicros ?? UNLIMITED_MICROS,
      currency: options.defaultCurrency,
      blockAtLimit: false,
      periodKey: 'sem-orcamento',
      periodEndsInSeconds: 3600,
      maxConcurrentRequests: payload.max_concurrent_requests,
      contentCapture: payload.content_capture,
      stale: false,
    };
  }

  const periodEnd = new Date(budget.period_end);
  const secondsToEnd = Math.max(60, Math.ceil((periodEnd.getTime() - Date.now()) / 1000));
  // Periodo maior que 2 dias so pode ser mensal.
  const period = secondsToEnd > 2 * 24 * 60 * 60 ? 'monthly' : 'daily';

  return {
    policy: snapshot,
    limitMicros: BigInt(budget.limit_micros),
    currency: budget.currency,
    blockAtLimit: budget.block_at_limit,
    periodKey: periodKeyFrom(periodEnd, period),
    periodEndsInSeconds: secondsToEnd,
    maxConcurrentRequests: payload.max_concurrent_requests,
    contentCapture: payload.content_capture,
    stale: false,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

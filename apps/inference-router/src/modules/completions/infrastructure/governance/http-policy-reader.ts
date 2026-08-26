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
  /** Service token. The router calls governance as a service, not as a user. */
  serviceToken: () => Promise<string>;
  cacheTtlSeconds: number;
  defaultCurrency: string;
  /** Implicit limit when the project has no configured budget. */
  unlimitedMicros?: bigint;
}

/**
 * Project policy with a local cache and graceful degradation.
 *
 * This is the platform's busiest endpoint: one round trip to governance per
 * inference request would put a control-plane service on the critical path. The
 * short-TTL cache solves that.
 *
 * When governance goes down, the last known policy stays in force and the
 * response is flagged `policy_stale=true` (reference doc 02 §8). Refusing all
 * inference because the policy service restarted would trade a small risk for a
 * total outage.
 */
@Injectable()
export class HttpPolicyReader implements PolicyReader {
  private readonly logger = new Logger(HttpPolicyReader.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly executor = new ResilienceExecutor(POLICIES.INTERNAL);

  constructor(private readonly options: HttpPolicyReaderOptions) {}

  /** Called by the `PolicyChanged` consumer, to invalidate ahead of the TTL. */
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
          `governance unreachable (${describe(error)}); serving cached policy for ${projectId}`,
        );
        // Extends the expired cache: without this, every request would repeat the failure.
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

    if (response.status === 404) throw new NotFoundError('Project', projectId);
    if (!response.ok) {
      throw new Error(`governance responded ${response.status.toString()}`);
    }

    return toPolicyResult((await response.json()) as PolicyResponse, this.options);
  }
}

/** `2026-03` for a monthly budget, `2026-03-15` for a daily one. */
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
    // A project with no configured budget is not blocked: governance decides
    // when to require a budget, the router only enforces what exists.
    return {
      policy: snapshot,
      limitMicros: options.unlimitedMicros ?? UNLIMITED_MICROS,
      currency: options.defaultCurrency,
      blockAtLimit: false,
      periodKey: 'no-budget',
      periodEndsInSeconds: 3600,
      maxConcurrentRequests: payload.max_concurrent_requests,
      contentCapture: payload.content_capture,
      stale: false,
    };
  }

  const periodEnd = new Date(budget.period_end);
  const secondsToEnd = Math.max(60, Math.ceil((periodEnd.getTime() - Date.now()) / 1000));
  // A period longer than two days can only be monthly.
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

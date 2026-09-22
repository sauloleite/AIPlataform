import { Injectable, Logger } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import type { ClassificationReader } from '../../application/ports.js';

/** How long a classification is trusted. It changes rarely, and never mid-conversation. */
const CACHE_TTL_MS = 30_000;

/**
 * The project's data classification, from aia-governance.
 *
 * Read with the CALLER's token (ADR-017): governance lets a member read their
 * own project's policy, so the gateway needs no credential of its own.
 *
 * Cached per project, briefly. An agent run lists its tools and then calls
 * them in a loop, and a governance round trip on every search would put the
 * control plane on the hot path. Serving a cached value to another caller
 * leaks nothing: every route reaches this only after checking that caller is
 * a member of the project, and a classification is not a secret from a member.
 * A FAILED read is never cached -- the next call asks again.
 */
@Injectable()
export class GovernanceClassificationReader implements ClassificationReader {
  private readonly logger = new Logger(GovernanceClassificationReader.name);
  private readonly executor = new ResilienceExecutor(POLICIES.INTERNAL);
  private readonly cache = new Map<string, { classification: string; expiresAt: number }>();

  constructor(
    private readonly governanceUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async classificationOf(input: { projectId: string; accessToken: string }): Promise<string> {
    const cached = this.cache.get(input.projectId);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.classification;

    if (this.governanceUrl === '') {
      throw new Error('GOVERNANCE_URL is not configured, so no classification can be read');
    }

    try {
      const classification = await this.executor.execute(
        async (signal) => {
          const response = await this.fetchImpl(
            `${this.governanceUrl}/v1/projects/${encodeURIComponent(input.projectId)}/policy`,
            {
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${input.accessToken}`,
                'X-Project-Id': input.projectId,
              },
              signal,
            },
          );
          if (!response.ok) throw new Error(`governance answered ${response.status.toString()}`);

          const body = (await response.json()) as { data_classification?: unknown };
          if (typeof body.data_classification !== 'string' || body.data_classification === '') {
            throw new Error('governance answered a policy without a classification');
          }
          return body.data_classification;
        },
        { key: 'governance' },
      );

      this.cache.set(input.projectId, { classification, expiresAt: this.now() + CACHE_TTL_MS });
      return classification;
    } catch (error) {
      // Logged here, where the cause is known; the use case only learns that
      // there is no classification, and refuses what needed one.
      this.logger.warn(`could not read the classification of ${input.projectId}: ${String(error)}`);
      throw error;
    }
  }
}

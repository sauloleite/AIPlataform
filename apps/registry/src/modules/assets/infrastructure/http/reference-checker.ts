import { Injectable, Logger } from '@nestjs/common';
import { POLICIES, ResilienceExecutor } from '@aia/resilience';

import type { ReferenceChecker } from '../../application/ports.js';

interface ModelsResponse {
  data?: { id?: string }[];
}

/**
 * Resolves the things an agent definition points at, over contracts.
 *
 * The registry never imports another service's domain: it asks the
 * inference-router whether an alias exists and aia-knowledge whether a store
 * does, and gets a yes or a no.
 */
@Injectable()
export class HttpReferenceChecker implements ReferenceChecker {
  private readonly logger = new Logger(HttpReferenceChecker.name);
  private readonly executor = new ResilienceExecutor(POLICIES.INTERNAL);

  constructor(
    private readonly options: {
      routerUrl: string;
      /** Empty until aia-knowledge is deployed. See `storesExist`. */
      knowledgeUrl: string;
    },
  ) {}

  /** Returns the ids that could NOT be resolved. */
  async storesExist(input: {
    projectId: string;
    accessToken: string;
    storeIds: readonly string[];
  }): Promise<readonly string[]> {
    const { projectId, accessToken, storeIds } = input;
    if (storeIds.length === 0) return [];

    // Fail CLOSED when knowledge is not configured. Publishing an agent whose
    // retrieval silently does nothing is worse than refusing to publish it, and
    // the error names the reason rather than leaving a mystery.
    if (this.options.knowledgeUrl === '') {
      this.logger.warn(
        'a definition references vector stores but KNOWLEDGE_URL is unset; refusing to publish',
      );
      return storeIds;
    }

    const missing: string[] = [];
    for (const storeId of storeIds) {
      if (!(await this.storeExists(projectId, accessToken, storeId))) missing.push(storeId);
    }
    return missing;
  }

  async aliasExists(input: {
    projectId: string;
    accessToken: string;
    alias: string;
  }): Promise<boolean> {
    const { projectId, accessToken, alias } = input;
    try {
      const body = await this.executor.execute<ModelsResponse>(async (signal) => {
        const response = await fetch(`${this.options.routerUrl}/v1/models`, {
          headers: this.headers(projectId, accessToken),
          signal,
        });
        if (!response.ok) throw new Error(`models responded ${response.status.toString()}`);
        return (await response.json()) as ModelsResponse;
      });

      return (body.data ?? []).some((model: { id?: string }) => model.id === alias);
    } catch (error) {
      // A catalogue that cannot be reached must not silently approve an alias
      // that does not exist, so this fails closed too.
      this.logger.warn(`could not verify alias "${alias}": ${String(error)}`);
      return false;
    }
  }

  private async storeExists(
    projectId: string,
    accessToken: string,
    storeId: string,
  ): Promise<boolean> {
    try {
      return await this.executor.execute<boolean>(async (signal) => {
        const response = await fetch(
          `${this.options.knowledgeUrl}/v1/stores/${encodeURIComponent(storeId)}`,
          { headers: this.headers(projectId, accessToken), signal },
        );
        if (response.status === 404) return false;
        if (!response.ok) throw new Error(`knowledge responded ${response.status.toString()}`);
        return true;
      });
    } catch (error) {
      this.logger.warn(`could not verify store "${storeId}": ${String(error)}`);
      return false;
    }
  }

  private headers(projectId: string, accessToken: string): Record<string, string> {
    return {
      'X-Project-Id': projectId,
      ...(accessToken !== '' && { Authorization: `Bearer ${accessToken}` }),
    };
  }
}

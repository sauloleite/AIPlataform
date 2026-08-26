import type { Deployment } from '../entities/deployment.js';
import type { ModelAlias } from '../entities/model-alias.js';
import {
  AliasNotAllowedError,
  CapabilityNotSupportedError,
  NoCompatibleDeploymentError,
} from '../errors/index.js';
import type { Capability } from '../entities/model-alias.js';
import type { DataClassification, DataZone } from '../value-objects/index.js';

/** What the project policy says, in the shape the domain understands. */
export interface ProjectPolicySnapshot {
  projectId: string;
  classification: DataClassification;
  allowedZones: readonly DataZone[];
  isAliasAllowed(alias: string): boolean;
  maxOutputTokensFor(alias: string): number | undefined;
}

/**
 * ADR-010: model routing is conditioned on data classification.
 *
 * A PURE rule: no I/O, no framework, no clock. This is the platform's regulatory
 * heart — where a `restricted` project is guaranteed to be served only by a
 * local model, and where audit can prove it afterwards.
 *
 * A project policy may NARROW the zones, never widen them: the allowed-zone list
 * already arrives derived from the classification.
 */
export const ModelSelectionPolicy = {
  /**
   * Deployments that may serve, in the order they should be tried.
   *
   * Throws instead of returning an empty list: "no compatible destination" is a
   * business answer, not an edge case for the caller to infer.
   */
  compatible(
    alias: ModelAlias,
    policy: ProjectPolicySnapshot,
    capability: Capability,
  ): Deployment[] {
    if (!alias.supports(capability)) {
      throw new CapabilityNotSupportedError(alias.id, capability);
    }
    if (!policy.isAliasAllowed(alias.id)) {
      throw new AliasNotAllowedError(alias.id, policy.projectId);
    }

    const enabled = alias.deployments.filter((deployment) => deployment.enabled);
    const compatible = enabled.filter((deployment) =>
      policy.allowedZones.includes(deployment.dataZone),
    );

    if (compatible.length === 0) {
      throw new NoCompatibleDeploymentError({
        alias: alias.id,
        classification: policy.classification,
        allowedZones: policy.allowedZones,
        availableZones: [...new Set(enabled.map((deployment) => deployment.dataZone))],
      });
    }

    // Already ordered by the alias's priority; filtering preserves that order.
    return compatible;
  },

  /**
   * The effective output token ceiling.
   *
   * The smallest of what the client asked for, what the project policy permits
   * and what the deployment can take. Without it, LLM10 (unbounded consumption)
   * stays wide open.
   */
  effectiveMaxOutputTokens(
    requested: number | undefined,
    deployment: Deployment,
    policy: ProjectPolicySnapshot,
    aliasId: string,
  ): number {
    const candidates = [deployment.maxOutputTokens];
    if (requested !== undefined) candidates.push(requested);

    const policyLimit = policy.maxOutputTokensFor(aliasId);
    if (policyLimit !== undefined) candidates.push(policyLimit);

    return Math.min(...candidates);
  },

  /** Aliases this project can actually use. Backs `GET /v1/models`. */
  visibleAliases(aliases: readonly ModelAlias[], policy: ProjectPolicySnapshot): ModelAlias[] {
    return aliases.filter((alias) => {
      if (!policy.isAliasAllowed(alias.id)) return false;
      return alias.deployments.some(
        (deployment) => deployment.enabled && policy.allowedZones.includes(deployment.dataZone),
      );
    });
  },
} as const;

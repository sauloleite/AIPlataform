import type { Deployment } from '../entities/deployment.js';
import type { ModelAlias } from '../entities/model-alias.js';
import {
  AliasNotAllowedError,
  CapabilityNotSupportedError,
  NoCompatibleDeploymentError,
} from '../errors/index.js';
import type { Capability } from '../entities/model-alias.js';
import type { DataClassification, DataZone } from '../value-objects/index.js';

/** O que a politica do projeto diz, na forma que o dominio entende. */
export interface ProjectPolicySnapshot {
  projectId: string;
  classification: DataClassification;
  allowedZones: readonly DataZone[];
  isAliasAllowed(alias: string): boolean;
  maxOutputTokensFor(alias: string): number | undefined;
}

/**
 * ADR-010: o roteamento de modelo e condicionado a classificacao de dados.
 *
 * Regra PURA: sem I/O, sem framework, sem relogio. E o coracao regulatorio da
 * plataforma — e onde se garante que um projeto `restrito` so e atendido por um
 * modelo local, e que a auditoria pode provar isso depois.
 *
 * A politica do projeto pode RESTRINGIR as zonas, nunca amplia-las: a lista de
 * zonas permitidas ja chega derivada da classificacao.
 */
export const ModelSelectionPolicy = {
  /**
   * Deployments que podem atender, na ordem em que devem ser tentados.
   *
   * Lanca em vez de devolver lista vazia: "nao ha destino compativel" e uma
   * resposta de negocio, nao um caso de borda para o chamador adivinhar.
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

    // Ja vem ordenado por prioridade do alias; a filtragem preserva a ordem.
    return compatible;
  },

  /**
   * Teto de tokens de saida efetivo.
   *
   * O menor entre o que o cliente pediu, o que a politica do projeto permite e o
   * que o deployment aguenta. Sem isso, LLM10 (consumo ilimitado) fica aberto.
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

  /** Aliases que este projeto consegue usar. Alimenta `GET /v1/models`. */
  visibleAliases(aliases: readonly ModelAlias[], policy: ProjectPolicySnapshot): ModelAlias[] {
    return aliases.filter((alias) => {
      if (!policy.isAliasAllowed(alias.id)) return false;
      return alias.deployments.some(
        (deployment) => deployment.enabled && policy.allowedZones.includes(deployment.dataZone),
      );
    });
  },
} as const;

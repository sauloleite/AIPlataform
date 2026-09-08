import { Injectable } from '@nestjs/common';
import { Deployment } from '../../domain/entities/deployment.js';
import { ModelAlias } from '../../domain/entities/model-alias.js';
import type { Capability } from '../../domain/entities/model-alias.js';
import type { AliasRegistry } from '../../application/ports.js';
import type { DataZone, ProviderName } from '../../domain/value-objects/index.js';

/**
 * The declarative shape of an alias, as it appears in configuration.
 *
 * The catalogue is still compiled in, which means changing a model is a deploy
 * rather than a catalogue edit -- the one place this platform's own promise is
 * only half true. `aia-registry` now exists to hold it as a `model` asset, and
 * the `AliasRegistry` port already isolates the choice: swapping this file for
 * a registry client touches no use case. Roadmap M12, together with the
 * deprecation dates and the regression gate that a real catalogue enables.
 */
export interface AliasDefinition {
  id: string;
  description?: string;
  capabilities: Capability[];
  deployments: {
    id: string;
    provider: ProviderName;
    model: string;
    dataZone: DataZone;
    priority: number;
    /** Cost per million tokens, in micros. Zero for a local model. */
    inputCostPerMillion: number;
    outputCostPerMillion: number;
    currency: string;
    maxOutputTokens: number;
    /** Vector width. Embeddings only, and what stops a failover changing it. */
    dimensions?: number;
    enabled?: boolean;
    deprecatedAt?: string;
  }[];
}

@Injectable()
export class InMemoryAliasRegistry implements AliasRegistry {
  private readonly byId = new Map<string, ModelAlias>();

  constructor(definitions: AliasDefinition[]) {
    for (const definition of definitions) {
      const deployments = definition.deployments.map(
        (deployment) =>
          new Deployment({
            id: deployment.id,
            provider: deployment.provider,
            model: deployment.model,
            dataZone: deployment.dataZone,
            priority: deployment.priority,
            inputCostPerMillion: BigInt(deployment.inputCostPerMillion),
            outputCostPerMillion: BigInt(deployment.outputCostPerMillion),
            currency: deployment.currency,
            maxOutputTokens: deployment.maxOutputTokens,
            ...(deployment.dimensions !== undefined && { dimensions: deployment.dimensions }),
            enabled: deployment.enabled ?? true,
            ...(deployment.deprecatedAt !== undefined && {
              deprecatedAt: new Date(deployment.deprecatedAt),
            }),
          }),
      );

      this.byId.set(
        definition.id,
        ModelAlias.of({
          id: definition.id,
          ...(definition.description !== undefined && { description: definition.description }),
          capabilities: definition.capabilities,
          deployments,
        }),
      );
    }
  }

  async find(aliasId: string): Promise<ModelAlias | null> {
    return this.byId.get(aliasId) ?? null;
  }

  async all(): Promise<ModelAlias[]> {
    return [...this.byId.values()];
  }
}

/**
 * The default catalogue.
 *
 * Each alias deliberately mixes providers from different zones: that is how an
 * `internal` project uses the cheapest external model while a `restricted`
 * project, asking for the SAME alias, is served locally by Ollama (ADR-010).
 *
 * `chat-local` exists for anyone who wants to guarantee nothing leaves the
 * machine even without a restricted classification. Because Ollama always
 * appears as the last option of every chat alias, the platform keeps answering
 * with no API key at all.
 */
export function defaultAliasCatalog(models: {
  ollamaChat: string;
  ollamaEmbedding: string;
  openaiChat: string;
  openaiEmbedding: string;
  geminiChat: string;
  geminiAdvanced: string;
  geminiEmbedding: string;
  anthropicChat: string;
}): AliasDefinition[] {
  return [
    {
      id: 'chat-fast',
      description: 'General-purpose chat, tuned for cost and latency',
      // `tools` as well: every provider behind this alias supports function
      // calling, so an agent does not have to reach for `chat-advanced` and
      // its far more expensive deployment just to call one tool.
      capabilities: ['chat', 'tools'],
      deployments: [
        {
          id: 'gemini-flash',
          provider: 'gemini',
          model: models.geminiChat,
          dataZone: 'global',
          priority: 0,
          inputCostPerMillion: 500_000,
          outputCostPerMillion: 2_000_000,
          currency: 'BRL',
          maxOutputTokens: 8192,
        },
        {
          // A SECOND Gemini, on a different model. The failover that matters
          // most in practice is not between vendors but between models at one
          // vendor: `flash-latest` returning 503 for "high demand" while
          // another flash answers in under a second is a thing that happens.
          // The keys rotate underneath both.
          id: 'gemini-flash-alt',
          provider: 'gemini',
          model: models.geminiAdvanced,
          dataZone: 'global',
          priority: 1,
          inputCostPerMillion: 600_000,
          outputCostPerMillion: 2_400_000,
          currency: 'BRL',
          maxOutputTokens: 8192,
        },
        {
          id: 'openai-mini',
          provider: 'openai',
          model: models.openaiChat,
          dataZone: 'us',
          priority: 2,
          inputCostPerMillion: 800_000,
          outputCostPerMillion: 3_200_000,
          currency: 'BRL',
          maxOutputTokens: 8192,
        },
        {
          id: 'ollama-local',
          provider: 'ollama',
          model: models.ollamaChat,
          dataZone: 'local',
          priority: 3,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 4096,
        },
      ],
    },
    {
      id: 'chat-advanced',
      description: 'Longer reasoning, for complex tasks',
      capabilities: ['chat', 'tools'],
      deployments: [
        {
          id: 'anthropic-sonnet',
          provider: 'anthropic',
          model: models.anthropicChat,
          dataZone: 'us',
          priority: 0,
          inputCostPerMillion: 15_000_000,
          outputCostPerMillion: 75_000_000,
          currency: 'BRL',
          maxOutputTokens: 16384,
        },
        {
          id: 'gemini-pro',
          provider: 'gemini',
          model: models.geminiAdvanced,
          dataZone: 'global',
          priority: 1,
          inputCostPerMillion: 6_000_000,
          outputCostPerMillion: 24_000_000,
          currency: 'BRL',
          maxOutputTokens: 16384,
        },
        {
          id: 'ollama-local-advanced',
          provider: 'ollama',
          model: models.ollamaChat,
          dataZone: 'local',
          priority: 2,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 4096,
        },
      ],
    },
    {
      id: 'chat-local',
      description: 'Local model only. No data leaves the machine.',
      capabilities: ['chat'],
      deployments: [
        {
          id: 'ollama-only',
          provider: 'ollama',
          model: models.ollamaChat,
          dataZone: 'local',
          priority: 0,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 4096,
        },
      ],
    },
    {
      id: 'embedding-default',
      description: 'Embeddings for semantic search',
      capabilities: ['embeddings'],
      deployments: [
        {
          id: 'openai-embed',
          provider: 'openai',
          model: models.openaiEmbedding,
          dataZone: 'us',
          priority: 0,
          inputCostPerMillion: 100_000,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 1,
          dimensions: 1536,
        },
        {
          id: 'gemini-embed',
          provider: 'gemini',
          model: models.geminiEmbedding,
          dataZone: 'global',
          priority: 1,
          inputCostPerMillion: 80_000,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 1,
          dimensions: 3072,
        },
        {
          id: 'ollama-embed',
          provider: 'ollama',
          model: models.ollamaEmbedding,
          dataZone: 'local',
          priority: 2,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 1,
          dimensions: 768,
        },
      ],
    },
  ];
}

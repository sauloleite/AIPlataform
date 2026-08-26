import { Injectable } from '@nestjs/common';
import { Deployment } from '../../domain/entities/deployment.js';
import { ModelAlias } from '../../domain/entities/model-alias.js';
import type { Capability } from '../../domain/entities/model-alias.js';
import type { AliasRegistry } from '../../application/ports.js';
import type { DataZone, ProviderName } from '../../domain/value-objects/index.js';

/**
 * Forma declarativa de um alias, como aparece na configuracao.
 *
 * O catalogo vive em arquivo ate o `aia-registry` existir (Fase 2 do roadmap).
 * O port `AliasRegistry` ja isola essa escolha: trocar arquivo por servico nao
 * toca em nenhum caso de uso.
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
    /** Custo por milhao de tokens, em micros da moeda. Zero para modelo local. */
    inputCostPerMillion: number;
    outputCostPerMillion: number;
    currency: string;
    maxOutputTokens: number;
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
 * Catalogo padrao.
 *
 * Cada alias mistura provedores de zonas diferentes de proposito: e assim que um
 * projeto `interno` usa o modelo externo mais barato enquanto um projeto
 * `restrito`, com o MESMO alias, e atendido localmente pelo Ollama (ADR-010).
 *
 * `chat-local` existe para quem quer garantir que nada saia da maquina mesmo sem
 * classificacao restrita. Como o Ollama sempre aparece como ultima opcao de todo
 * alias de chat, a plataforma continua respondendo sem nenhuma chave de API.
 */
export function defaultAliasCatalog(models: {
  ollamaChat: string;
  ollamaEmbedding: string;
  openaiChat: string;
  openaiEmbedding: string;
  geminiChat: string;
  geminiEmbedding: string;
  anthropicChat: string;
}): AliasDefinition[] {
  return [
    {
      id: 'chat-rapido',
      description: 'Conversa de uso geral, otimizada para custo e latencia',
      capabilities: ['chat'],
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
          id: 'openai-mini',
          provider: 'openai',
          model: models.openaiChat,
          dataZone: 'us',
          priority: 1,
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
          priority: 2,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 4096,
        },
      ],
    },
    {
      id: 'chat-avancado',
      description: 'Raciocinio mais longo, para tarefas complexas',
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
          id: 'ollama-local-avancado',
          provider: 'ollama',
          model: models.ollamaChat,
          dataZone: 'local',
          priority: 1,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          currency: 'BRL',
          maxOutputTokens: 4096,
        },
      ],
    },
    {
      id: 'chat-local',
      description: 'Somente modelo local. Nenhum dado sai da maquina.',
      capabilities: ['chat'],
      deployments: [
        {
          id: 'ollama-exclusivo',
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
      id: 'embedding-padrao',
      description: 'Embeddings para busca semantica',
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
        },
      ],
    },
  ];
}

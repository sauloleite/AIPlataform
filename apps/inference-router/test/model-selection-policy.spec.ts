import { describe, expect, it } from 'vitest';
import { ModelSelectionPolicy } from '../src/modules/completions/domain/services/model-selection-policy.js';
import {
  AliasNotAllowedError,
  CapabilityNotSupportedError,
  NoCompatibleDeploymentError,
} from '../src/modules/completions/domain/errors/index.js';
import { aDeployment, aPolicy, anAlias } from './builders.js';

describe('ModelSelectionPolicy.compatible (ADR-010)', () => {
  const local = aDeployment({
    id: 'ollama-local',
    provider: 'ollama',
    dataZone: 'local',
    priority: 2,
  });
  const openai = aDeployment({ id: 'openai-us', provider: 'openai', dataZone: 'us', priority: 0 });
  const gemini = aDeployment({
    id: 'gemini-global',
    provider: 'gemini',
    dataZone: 'global',
    priority: 1,
  });
  const alias = anAlias([local, openai, gemini]);

  it('ordena por prioridade, do menor para o maior', () => {
    const chosen = ModelSelectionPolicy.compatible(alias, aPolicy(), 'chat');
    expect(chosen.map((d) => d.id)).toEqual(['openai-us', 'gemini-global', 'ollama-local']);
  });

  it('projeto restrito e atendido SOMENTE pelo modelo local', () => {
    const chosen = ModelSelectionPolicy.compatible(
      alias,
      aPolicy({ classification: 'restrito', allowedZones: ['local'] }),
      'chat',
    );
    expect(chosen.map((d) => d.id)).toEqual(['ollama-local']);
  });

  it('projeto confidencial nao alcanca provedor fora do pais', () => {
    const chosen = ModelSelectionPolicy.compatible(
      alias,
      aPolicy({ classification: 'confidencial', allowedZones: ['local', 'br'] }),
      'chat',
    );
    expect(chosen.every((d) => d.dataZone === 'local' || d.dataZone === 'br')).toBe(true);
  });

  it('falha em vez de enviar o dado quando nao ha destino compativel', () => {
    const soExterno = anAlias([openai, gemini]);
    try {
      ModelSelectionPolicy.compatible(
        soExterno,
        aPolicy({ classification: 'restrito', allowedZones: ['local'] }),
        'chat',
      );
      expect.unreachable('deveria ter lancado');
    } catch (error) {
      expect(error).toBeInstanceOf(NoCompatibleDeploymentError);
      const details = (error as NoCompatibleDeploymentError).details;
      // A auditoria precisa saber o que foi pedido e o que existia.
      expect(details['data_classification']).toBe('restrito');
      expect(details['allowed_zones']).toEqual(['local']);
      expect(details['available_zones']).toEqual(['us', 'global']);
    }
  });

  it('ignora deployment desabilitado', () => {
    const desligado = anAlias([
      aDeployment({ id: 'off', dataZone: 'local', enabled: false }),
      openai,
    ]);
    expect(ModelSelectionPolicy.compatible(desligado, aPolicy(), 'chat').map((d) => d.id)).toEqual([
      'openai-us',
    ]);
  });

  it('deployment desabilitado nao conta como zona disponivel no erro', () => {
    const soDesligadoLocal = anAlias([
      aDeployment({ id: 'off', dataZone: 'local', enabled: false }),
    ]);
    expect(() => ModelSelectionPolicy.compatible(soDesligadoLocal, aPolicy(), 'chat')).toThrow(
      NoCompatibleDeploymentError,
    );
  });

  it('recusa alias bloqueado pela politica do projeto', () => {
    expect(() =>
      ModelSelectionPolicy.compatible(alias, aPolicy({ blockedAliases: ['chat-rapido'] }), 'chat'),
    ).toThrow(AliasNotAllowedError);
  });

  it('recusa capacidade que o alias nao tem', () => {
    expect(() => ModelSelectionPolicy.compatible(alias, aPolicy(), 'embeddings')).toThrow(
      CapabilityNotSupportedError,
    );
  });

  it('checa a permissao do alias antes da zona: o motivo do erro precisa ser o real', () => {
    const soExterno = anAlias([openai]);
    expect(() =>
      ModelSelectionPolicy.compatible(
        soExterno,
        aPolicy({ blockedAliases: ['chat-rapido'], allowedZones: ['local'] }),
        'chat',
      ),
    ).toThrow(AliasNotAllowedError);
  });
});

describe('ModelSelectionPolicy.effectiveMaxOutputTokens (OWASP LLM10)', () => {
  const deployment = aDeployment({ maxOutputTokens: 4096 });

  it('sem pedido do cliente, usa o teto do deployment', () => {
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(
        undefined,
        deployment,
        aPolicy(),
        'chat-rapido',
      ),
    ).toBe(4096);
  });

  it('respeita o pedido do cliente quando cabe', () => {
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(500, deployment, aPolicy(), 'chat-rapido'),
    ).toBe(500);
  });

  it('nao deixa o cliente pedir mais do que o deployment aguenta', () => {
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(999_999, deployment, aPolicy(), 'chat-rapido'),
    ).toBe(4096);
  });

  it('o limite da politica do projeto vence o pedido do cliente', () => {
    const policy = aPolicy({ maxOutputTokens: { 'chat-rapido': 256 } });
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(2000, deployment, policy, 'chat-rapido'),
    ).toBe(256);
  });
});

describe('ModelSelectionPolicy.visibleAliases', () => {
  it('esconde alias sem nenhum deployment compativel com o projeto', () => {
    const localOnly = anAlias([aDeployment({ dataZone: 'local' })], { id: 'chat-local' });
    const externoOnly = anAlias([aDeployment({ id: 'x', dataZone: 'us' })], { id: 'chat-externo' });
    const policy = aPolicy({ classification: 'restrito', allowedZones: ['local'] });

    expect(
      ModelSelectionPolicy.visibleAliases([localOnly, externoOnly], policy).map((a) => a.id),
    ).toEqual(['chat-local']);
  });
});

describe('Deployment.costOf', () => {
  it('calcula o custo a partir da tabela de precos do deployment', () => {
    // R$ 0,50 por milhao de tokens de entrada, R$ 1,50 de saida.
    const deployment = aDeployment({
      inputCostPerMillion: 500_000n,
      outputCostPerMillion: 1_500_000n,
    });
    const cost = deployment.costOf(1_000_000, 1_000_000);
    expect(cost.micros).toBe(2_000_000n);
    expect(cost.toUnits()).toBe(2);
  });

  it('arredonda para cima: nunca cobrar a menos do orcamento', () => {
    const deployment = aDeployment({ inputCostPerMillion: 1n, outputCostPerMillion: 0n });
    expect(deployment.costOf(1, 0).micros).toBe(1n);
  });

  it('modelo local custa zero, e por isso a plataforma roda sem chave de API', () => {
    expect(aDeployment({ provider: 'ollama' }).costOf(10_000, 10_000).micros).toBe(0n);
  });
});

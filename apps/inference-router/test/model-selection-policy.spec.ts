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

  it('orders by priority, lowest first', () => {
    const chosen = ModelSelectionPolicy.compatible(alias, aPolicy(), 'chat');
    expect(chosen.map((d) => d.id)).toEqual(['openai-us', 'gemini-global', 'ollama-local']);
  });

  it('a restricted project is served ONLY by the local model', () => {
    const chosen = ModelSelectionPolicy.compatible(
      alias,
      aPolicy({ classification: 'restricted', allowedZones: ['local'] }),
      'chat',
    );
    expect(chosen.map((d) => d.id)).toEqual(['ollama-local']);
  });

  it('a confidential project cannot reach a provider outside the country', () => {
    const chosen = ModelSelectionPolicy.compatible(
      alias,
      aPolicy({ classification: 'confidential', allowedZones: ['local', 'br'] }),
      'chat',
    );
    expect(chosen.every((d) => d.dataZone === 'local' || d.dataZone === 'br')).toBe(true);
  });

  it('fails rather than sending the data when no compatible destination exists', () => {
    const soExterno = anAlias([openai, gemini]);
    try {
      ModelSelectionPolicy.compatible(
        soExterno,
        aPolicy({ classification: 'restricted', allowedZones: ['local'] }),
        'chat',
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NoCompatibleDeploymentError);
      const details = (error as NoCompatibleDeploymentError).details;
      // Audit needs to know what was asked for and what existed.
      expect(details['data_classification']).toBe('restricted');
      expect(details['allowed_zones']).toEqual(['local']);
      expect(details['available_zones']).toEqual(['us', 'global']);
    }
  });

  it('ignores a disabled deployment', () => {
    const desligado = anAlias([
      aDeployment({ id: 'off', dataZone: 'local', enabled: false }),
      openai,
    ]);
    expect(ModelSelectionPolicy.compatible(desligado, aPolicy(), 'chat').map((d) => d.id)).toEqual([
      'openai-us',
    ]);
  });

  it('a disabled deployment does not count as an available zone in the error', () => {
    const soDesligadoLocal = anAlias([
      aDeployment({ id: 'off', dataZone: 'local', enabled: false }),
    ]);
    expect(() => ModelSelectionPolicy.compatible(soDesligadoLocal, aPolicy(), 'chat')).toThrow(
      NoCompatibleDeploymentError,
    );
  });

  it('rejects an alias blocked by the project policy', () => {
    expect(() =>
      ModelSelectionPolicy.compatible(alias, aPolicy({ blockedAliases: ['chat-fast'] }), 'chat'),
    ).toThrow(AliasNotAllowedError);
  });

  it('rejects a capability the alias does not have', () => {
    expect(() => ModelSelectionPolicy.compatible(alias, aPolicy(), 'embeddings')).toThrow(
      CapabilityNotSupportedError,
    );
  });

  it('checks alias permission before zone: the error reason has to be the real one', () => {
    const soExterno = anAlias([openai]);
    expect(() =>
      ModelSelectionPolicy.compatible(
        soExterno,
        aPolicy({ blockedAliases: ['chat-fast'], allowedZones: ['local'] }),
        'chat',
      ),
    ).toThrow(AliasNotAllowedError);
  });
});

describe('ModelSelectionPolicy.effectiveMaxOutputTokens (OWASP LLM10)', () => {
  const deployment = aDeployment({ maxOutputTokens: 4096 });

  it('with no client request, uses the deployment ceiling', () => {
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(undefined, deployment, aPolicy(), 'chat-fast'),
    ).toBe(4096);
  });

  it('honours the client request when it fits', () => {
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(500, deployment, aPolicy(), 'chat-fast'),
    ).toBe(500);
  });

  it('does not let the client ask for more than the deployment can take', () => {
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(999_999, deployment, aPolicy(), 'chat-fast'),
    ).toBe(4096);
  });

  it('the project policy limit beats the client request', () => {
    const policy = aPolicy({ maxOutputTokens: { 'chat-fast': 256 } });
    expect(
      ModelSelectionPolicy.effectiveMaxOutputTokens(2000, deployment, policy, 'chat-fast'),
    ).toBe(256);
  });
});

describe('ModelSelectionPolicy.visibleAliases', () => {
  it('hides an alias with no deployment compatible with the project', () => {
    const localOnly = anAlias([aDeployment({ dataZone: 'local' })], { id: 'chat-local' });
    const externoOnly = anAlias([aDeployment({ id: 'x', dataZone: 'us' })], {
      id: 'chat-external',
    });
    const policy = aPolicy({ classification: 'restricted', allowedZones: ['local'] });

    expect(
      ModelSelectionPolicy.visibleAliases([localOnly, externoOnly], policy).map((a) => a.id),
    ).toEqual(['chat-local']);
  });
});

describe('Deployment.costOf', () => {
  it('computes the cost from the deployment price table', () => {
    // 0.50 per million input tokens, 1.50 per million output tokens.
    const deployment = aDeployment({
      inputCostPerMillion: 500_000n,
      outputCostPerMillion: 1_500_000n,
    });
    const cost = deployment.costOf(1_000_000, 1_000_000);
    expect(cost.micros).toBe(2_000_000n);
    expect(cost.toUnits()).toBe(2);
  });

  it('rounds up: never undercharge the budget', () => {
    const deployment = aDeployment({ inputCostPerMillion: 1n, outputCostPerMillion: 0n });
    expect(deployment.costOf(1, 0).micros).toBe(1n);
  });

  it('a local model costs zero, which is why the platform runs without an API key', () => {
    expect(aDeployment({ provider: 'ollama' }).costOf(10_000, 10_000).micros).toBe(0n);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { CreateChatCompletion } from '../src/modules/completions/application/use-cases/create-chat-completion.js';
import { DeploymentExecutor } from '../src/modules/completions/application/services/deployment-executor.js';
import {
  AliasNotFoundError,
  BudgetExhaustedError,
  GuardrailBlockedError,
  NoCompatibleDeploymentError,
  PromptInjectionSuspectedError,
} from '../src/modules/completions/domain/errors/index.js';
import type { CreateChatCompletionCommand } from '../src/modules/completions/application/dto.js';
import type { StreamEvent } from '../src/modules/completions/application/dto.js';
import { aDeployment, anAlias } from './builders.js';
import {
  FakeAliasRegistry,
  FakeAuditRepository,
  FakeBudgetLedger,
  FakeGuardrail,
  FakeModelProvider,
  FakePolicyReader,
  FakeSemanticCache,
  FakeUsagePublisher,
  FixedClock,
  WordTokenEstimator,
} from './fakes.js';

/**
 * Fluxo 7.1 do documento 02, exercitado com fakes.
 *
 * Nenhuma rede, nenhum container: o caso de uso conversa so com ports, entao os
 * caminhos de erro (orcamento estourado, zona incompativel, stream interrompido)
 * podem ser testados de forma deterministica.
 */

const LOCAL = aDeployment({
  id: 'ollama-local',
  provider: 'ollama',
  dataZone: 'local',
  priority: 1,
});

const OPENAI = aDeployment({
  id: 'openai-us',
  provider: 'openai',
  dataZone: 'us',
  priority: 0,
  // R$ 1,00 por milhao de tokens de entrada, R$ 2,00 de saida.
  inputCostPerMillion: 1_000_000n,
  outputCostPerMillion: 2_000_000n,
  maxOutputTokens: 1000,
});

interface Harness {
  useCase: CreateChatCompletion;
  ledger: FakeBudgetLedger;
  policies: FakePolicyReader;
  audit: FakeAuditRepository;
  usage: FakeUsagePublisher;
  guardrail: FakeGuardrail;
  cache: FakeSemanticCache;
  openai: FakeModelProvider;
  ollama: FakeModelProvider;
}

function build(
  options: {
    policy?: ConstructorParameters<typeof FakePolicyReader>[0];
    snapshot?: ConstructorParameters<typeof FakePolicyReader>[1];
    deployments?: (typeof LOCAL)[];
  } = {},
): Harness {
  const ledger = new FakeBudgetLedger();
  const policies = new FakePolicyReader(options.policy, options.snapshot);
  const audit = new FakeAuditRepository();
  const usage = new FakeUsagePublisher();
  const guardrail = new FakeGuardrail();
  const cache = new FakeSemanticCache();
  const openai = new FakeModelProvider('openai');
  const ollama = new FakeModelProvider('ollama');

  const alias = anAlias(options.deployments ?? [OPENAI, LOCAL]);
  const executor = new DeploymentExecutor([openai, ollama]);

  const useCase = new CreateChatCompletion(
    policies,
    new FakeAliasRegistry([alias]),
    ledger,
    guardrail,
    cache,
    new WordTokenEstimator(),
    audit,
    usage,
    new FixedClock(),
    executor,
  );

  return { useCase, ledger, policies, audit, usage, guardrail, cache, openai, ollama };
}

function aCommand(
  overrides: Partial<CreateChatCompletionCommand> = {},
): CreateChatCompletionCommand {
  return {
    requestId: 'req-1',
    projectId: 'proj-1',
    principalId: 'user-ana',
    alias: 'chat-rapido',
    messages: [{ role: 'user', content: 'ola tudo bem' }],
    stream: false,
    ...overrides,
  };
}

describe('CreateChatCompletion - caminho feliz', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = build();
  });

  it('atende pelo deployment de maior prioridade compativel', async () => {
    const result = await harness.useCase.execute(aCommand());

    expect(result.content).toBe('resposta determinada');
    expect(result.routing.deploymentId).toBe('openai-us');
    expect(result.routing.provider).toBe('openai');
    expect(result.routing.attempts).toBe(1);
  });

  it('reserva antes de chamar e comita o custo REAL depois', async () => {
    await harness.useCase.execute(aCommand());

    // Estimativa: 3 palavras de prompt + teto de 1000 de saida.
    const reserved = harness.ledger.reserved[0];
    expect(reserved?.estimated.micros).toBe(3n + 2000n);

    // Real: 100 tokens de entrada (R$ 0,0001) + 50 de saida (R$ 0,0001).
    const committed = harness.ledger.committed[0];
    expect(committed?.actual.micros).toBe(100n + 100n);
    expect(harness.ledger.released).toHaveLength(0);
  });

  it('grava auditoria com a zona de dados, que e a evidencia de residencia', async () => {
    await harness.useCase.execute(aCommand());

    expect(harness.audit.last()).toMatchObject({
      requestId: 'req-1',
      projectId: 'proj-1',
      principalId: 'user-ana',
      deploymentId: 'openai-us',
      dataZone: 'us',
      status: 'completed',
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it('publica UsageRecorded com custo, zona e classificacao', async () => {
    await harness.useCase.execute(aCommand());

    expect(harness.usage.last()).toMatchObject({
      alias: 'chat-rapido',
      provider: 'openai',
      dataZone: 'us',
      dataClassification: 'interno',
      status: 'completed',
      budgetUnverified: false,
      policyStale: false,
    });
  });

  it('nao grava conteudo quando o projeto nao optou por captura', async () => {
    await harness.useCase.execute(aCommand());

    expect(harness.audit.last()?.redactedPrompt).toBeUndefined();
    expect(harness.audit.last()?.redactedCompletion).toBeUndefined();
  });

  it('grava conteudo redigido quando o projeto opta pela captura', async () => {
    const withCapture = build({ policy: { contentCapture: true } });
    withCapture.guardrail.respondWith({ text: 'meu cpf e <BR_CPF>', redactedCount: 1 });

    await withCapture.useCase.execute(
      aCommand({ messages: [{ role: 'user', content: 'meu cpf e 111.444.777-35' }] }),
    );

    const record = withCapture.audit.last();
    expect(record?.redactedPrompt).toBe('meu cpf e <BR_CPF>');
    // O valor original nunca chega a persistencia.
    expect(record?.redactedPrompt).not.toContain('111.444.777-35');
  });
});

describe('CreateChatCompletion - roteamento por classificacao (ADR-010)', () => {
  it('projeto restrito e atendido pelo modelo local, e nao pelo mais barato', async () => {
    const harness = build({
      policy: {},
      snapshot: { classification: 'restrito', allowedZones: ['local'] },
    });

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.deploymentId).toBe('ollama-local');
    expect(result.routing.dataZone).toBe('local');
    // O provedor externo nem chegou a ser chamado.
    expect(harness.openai.calls).toHaveLength(0);
  });

  it('recusa quando nao ha nenhum destino compativel, em vez de enviar assim mesmo', async () => {
    const harness = build({
      deployments: [OPENAI],
      snapshot: { classification: 'restrito', allowedZones: ['local'] },
    });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(
      NoCompatibleDeploymentError,
    );
    expect(harness.openai.calls).toHaveLength(0);
    // Nada foi reservado: a recusa acontece antes de tocar no orcamento.
    expect(harness.ledger.reserved).toHaveLength(0);
  });

  it('recusa alias inexistente', async () => {
    const harness = build();
    await expect(harness.useCase.execute(aCommand({ alias: 'nao-existe' }))).rejects.toBeInstanceOf(
      AliasNotFoundError,
    );
  });
});

describe('CreateChatCompletion - orcamento', () => {
  it('recusa com 429 quando a reserva nao cabe no limite', async () => {
    const harness = build({ policy: { limitMicros: 10n } });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(harness.openai.calls).toHaveLength(0);
  });

  it('projeto que nao bloqueia no limite continua sendo atendido', async () => {
    const harness = build({ policy: { limitMicros: 1n, blockAtLimit: false } });
    await expect(harness.useCase.execute(aCommand())).resolves.toMatchObject({
      content: 'resposta determinada',
    });
  });

  it('libera a reserva quando a chamada ao provedor falha (compensacao da saga)', async () => {
    const harness = build();
    harness.openai.failNext(new Error('provedor fora'), 5);
    harness.ollama.failNext(new Error('local fora'), 5);

    await expect(harness.useCase.execute(aCommand())).rejects.toThrow();

    expect(harness.ledger.released).toHaveLength(1);
    expect(harness.ledger.committed).toHaveLength(0);
    // A falha vira evidencia: auditoria e evento saem mesmo sem sucesso.
    expect(harness.audit.last()?.status).toBe('failed');
    expect(harness.usage.last()?.status).toBe('failed');
  });

  it('sem Redis, atende marcando budget_unverified em vez de derrubar', async () => {
    const harness = build();
    harness.ledger.goDown();

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.budgetUnverified).toBe(true);
    expect(result.content).toBe('resposta determinada');
    expect(harness.ledger.reserved).toHaveLength(0);
    expect(harness.usage.last()?.budgetUnverified).toBe(true);
  });
});

describe('CreateChatCompletion - degradacao do governance', () => {
  it('responde com policy_stale quando a politica vem do cache', async () => {
    const harness = build();
    harness.policies.goStale();

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.policyStale).toBe(true);
    expect(harness.usage.last()?.policyStale).toBe(true);
  });
});

describe('CreateChatCompletion - failover entre deployments', () => {
  it('cai para o proximo deployment quando o primeiro falha', async () => {
    const harness = build();
    harness.openai.failNext(new Error('502 bad gateway'), 5);

    const result = await harness.useCase.execute(aCommand());

    expect(result.routing.deploymentId).toBe('ollama-local');
    expect(result.routing.attempts).toBe(2);
  });

  it('cobra o custo do deployment que REALMENTE atendeu', async () => {
    const harness = build();
    harness.openai.failNext(new Error('502'), 5);

    await harness.useCase.execute(aCommand());

    // O Ollama e local e custa zero, mesmo tendo reservado pelo preco do OpenAI.
    expect(harness.ledger.committed[0]?.actual.micros).toBe(0n);
  });
});

describe('CreateChatCompletion - guardrails (OWASP LLM01 e LLM02)', () => {
  it('envia ao provedor o texto ja redigido, nunca o original', async () => {
    const harness = build();
    harness.guardrail.respondWith({ text: 'meu cpf e <BR_CPF>', redactedCount: 1 });

    await harness.useCase.execute(
      aCommand({ messages: [{ role: 'user', content: 'meu cpf e 111.444.777-35' }] }),
    );

    const sent = harness.openai.calls[0]?.request.messages[0]?.content;
    expect(sent).toBe('meu cpf e <BR_CPF>');
  });

  it('bloqueia quando o guardrail decide bloquear', async () => {
    const harness = build();
    harness.guardrail.respondWith({ decision: 'block' });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(GuardrailBlockedError);
    expect(harness.openai.calls).toHaveLength(0);
  });

  it('recusa prompt com indicio forte de injecao', async () => {
    const harness = build();
    harness.guardrail.respondWith({
      injectionSuspected: true,
      injectionScore: 0.95,
      injectionSignals: ['ignore_previous_instructions'],
    });

    await expect(harness.useCase.execute(aCommand())).rejects.toBeInstanceOf(
      PromptInjectionSuspectedError,
    );
  });

  it('indicio fraco de injecao nao bloqueia: o limiar existe para evitar falso positivo', async () => {
    const harness = build();
    harness.guardrail.respondWith({ injectionSuspected: true, injectionScore: 0.4 });

    await expect(harness.useCase.execute(aCommand())).resolves.toMatchObject({
      content: 'resposta determinada',
    });
  });

  it('guardrail indisponivel nao derruba a inferencia', async () => {
    const harness = build();
    harness.guardrail.available = false;

    await expect(harness.useCase.execute(aCommand())).resolves.toBeDefined();
    expect(harness.guardrail.inspected).toHaveLength(0);
  });
});

describe('CreateChatCompletion - cache', () => {
  it('cache hit nao chama provedor e nao consome orcamento', async () => {
    const harness = build();
    harness.cache.primeWith({
      content: 'do cache',
      usage: { promptTokens: 10, completionTokens: 5 },
      deploymentId: 'openai-us',
    });

    const result = await harness.useCase.execute(aCommand());

    expect(result.content).toBe('do cache');
    expect(result.routing.cacheHit).toBe(true);
    expect(result.routing.cost.micros).toBe(0n);
    expect(harness.openai.calls).toHaveLength(0);
    expect(harness.ledger.reserved).toHaveLength(0);
  });

  it('guarda a resposta no cache apos uma chamada real', async () => {
    const harness = build();
    await harness.useCase.execute(aCommand());
    expect(harness.cache.stored[0]?.content).toBe('resposta determinada');
  });
});

describe('CreateChatCompletion - streaming', () => {
  async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it('emite deltas e termina com o resultado completo', async () => {
    const harness = build();
    const events = await collect(harness.useCase.stream(aCommand({ stream: true })));

    const deltas = events.filter((event) => event.kind === 'delta');
    expect(deltas.map((event) => event.content).join('')).toBe('resposta determinada');

    const finished = events.at(-1);
    expect(finished?.kind).toBe('finished');
    if (finished?.kind === 'finished') {
      expect(finished.result.content).toBe('resposta determinada');
      expect(finished.result.usage.totalTokens).toBe(150);
    }
  });

  it('comita o consumo real informado no ultimo chunk', async () => {
    const harness = build();
    await collect(harness.useCase.stream(aCommand({ stream: true })));

    expect(harness.ledger.committed[0]?.actual.micros).toBe(200n);
  });

  it('stream interrompido comita o parcial e marca o evento como partial', async () => {
    const harness = build();
    harness.openai.breakStreamAfter(1);

    const events = await collect(harness.useCase.stream(aCommand({ stream: true })));

    // O cliente recebeu conteudo: nao ha como retentar sem duplicar.
    expect(events.some((event) => event.kind === 'delta')).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'stream_interrupted' });

    expect(harness.ledger.committed).toHaveLength(1);
    expect(harness.ledger.released).toHaveLength(0);
    expect(harness.usage.last()?.status).toBe('partial');
    expect(harness.usage.last()?.errorCode).toBe('stream_interrupted');
  });

  it('falha ANTES do primeiro token libera a reserva e propaga o erro', async () => {
    const harness = build();
    harness.openai.failNext(new Error('502'), 5);
    harness.ollama.failNext(new Error('502'), 5);

    await expect(collect(harness.useCase.stream(aCommand({ stream: true })))).rejects.toThrow();

    expect(harness.ledger.released).toHaveLength(1);
    expect(harness.ledger.committed).toHaveLength(0);
  });

  it('registra o tempo ate o primeiro token, que e o SLI do router', async () => {
    const harness = build();
    await collect(harness.useCase.stream(aCommand({ stream: true })));

    expect(harness.usage.last()?.timeToFirstTokenMs).toBeDefined();
  });
});

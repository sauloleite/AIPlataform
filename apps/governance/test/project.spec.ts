import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { Project } from '../src/modules/projects/domain/entities/project.js';
import { DataClassification } from '../src/modules/projects/domain/value-objects/data-classification.js';

const NOW = new Date('2026-03-15T10:00:00Z');

const create = (overrides: Partial<Parameters<typeof Project.create>[0]> = {}): Project =>
  Project.create({
    id: 'proj-1',
    slug: 'assistente-credito',
    name: 'Assistente de Credito',
    classification: DataClassification.of('interno'),
    legalBasis: 'legitimo interesse',
    purpose: 'apoio a analise de credito',
    now: NOW,
    ...overrides,
  });

describe('Project', () => {
  it('nasce com as zonas maximas da classificacao', () => {
    expect(create().allowedZones).toEqual(['local', 'br', 'us', 'eu', 'global']);
    expect(create({ classification: DataClassification.of('confidencial') }).allowedZones).toEqual([
      'local',
      'br',
    ]);
  });

  it('exige base legal e finalidade (LGPD)', () => {
    expect(() => create({ legalBasis: '  ' })).toThrow(ValidationError);
    expect(() => create({ purpose: '' })).toThrow(ValidationError);
  });

  it.each(['ab', 'Projeto', 'com espaco', '-comeca-com-traco', 'termina-com-'])(
    'recusa o slug %p',
    (slug) => {
      expect(() => create({ slug })).toThrow(ValidationError);
    },
  );

  it('restringir zonas nao amplia o que a classificacao permite', () => {
    const project = create({ classification: DataClassification.of('confidencial') });
    project.restrictZones(['local', 'br', 'us'], NOW);
    expect(project.allowedZones).toEqual(['local', 'br']);
  });

  it('recusa restricao que deixaria o projeto sem zona nenhuma', () => {
    const project = create({ classification: DataClassification.of('restrito') });
    expect(() => {
      project.restrictZones(['us', 'eu'], NOW);
    }).toThrow(ValidationError);
  });

  it('projeto restrito nao pode gravar conteudo de conversa', () => {
    const project = create({ classification: DataClassification.of('restrito') });
    expect(() => {
      project.setContentCapture(true, NOW);
    }).toThrow(ValidationError);
    expect(() => {
      project.setContentCapture(false, NOW);
    }).not.toThrow();
  });

  it('alias sem regra explicita e permitido; a lista existe para excecoes', () => {
    const project = create();
    expect(project.isAliasAllowed('chat-rapido')).toBe(true);

    project.setModelRules([{ alias: 'chat-caro', allowed: false }], NOW);
    expect(project.isAliasAllowed('chat-caro')).toBe(false);
    expect(project.isAliasAllowed('chat-rapido')).toBe(true);
  });

  it('a versao da politica incrementa a cada mudanca, para invalidar o cache do router', () => {
    const project = create();
    expect(project.policyVersion).toBe(1);

    project.setMaxConcurrentRequests(5, NOW);
    expect(project.policyVersion).toBe(2);

    project.setModelRules([], NOW);
    expect(project.policyVersion).toBe(3);
  });

  it('recusa concorrencia maxima menor que 1', () => {
    expect(() => {
      create().setMaxConcurrentRequests(0, NOW);
    }).toThrow(ValidationError);
  });
});

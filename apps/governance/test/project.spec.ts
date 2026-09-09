import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { Project } from '../src/modules/projects/domain/entities/project.js';
import { DataClassification } from '../src/modules/projects/domain/value-objects/data-classification.js';

const NOW = new Date('2026-03-15T10:00:00Z');

const create = (overrides: Partial<Parameters<typeof Project.create>[0]> = {}): Project =>
  Project.create({
    id: 'proj-1',
    slug: 'credit-assistant',
    name: 'Credit Assistant',
    classification: DataClassification.of('internal'),
    legalBasis: 'legitimate interest',
    purpose: 'support for credit analysis',
    now: NOW,
    ...overrides,
  });

describe('Project', () => {
  it('starts with the maximum zones its classification allows', () => {
    expect(create().allowedZones).toEqual(['local', 'br', 'us', 'eu', 'global']);
    expect(create({ classification: DataClassification.of('confidential') }).allowedZones).toEqual([
      'local',
      'br',
    ]);
  });

  it('requires legal basis and purpose (LGPD)', () => {
    expect(() => create({ legalBasis: '  ' })).toThrow(ValidationError);
    expect(() => create({ purpose: '' })).toThrow(ValidationError);
  });

  it.each(['ab', 'Project', 'with space', '-starts-with-dash', 'ends-with-'])(
    'rejects the slug %p',
    (slug) => {
      expect(() => create({ slug })).toThrow(ValidationError);
    },
  );

  it('narrowing zones does not widen what the classification allows', () => {
    const project = create({ classification: DataClassification.of('confidential') });
    project.restrictZones(['local', 'br', 'us'], NOW);
    expect(project.allowedZones).toEqual(['local', 'br']);
  });

  it('rejects a restriction that would leave the project with no zone', () => {
    const project = create({ classification: DataClassification.of('restricted') });
    expect(() => {
      project.restrictZones(['us', 'eu'], NOW);
    }).toThrow(ValidationError);
  });

  it('a restricted project cannot record conversation content', () => {
    const project = create({ classification: DataClassification.of('restricted') });
    expect(() => {
      project.setContentCapture(true, NOW);
    }).toThrow(ValidationError);
    expect(() => {
      project.setContentCapture(false, NOW);
    }).not.toThrow();
  });

  it('an alias with no explicit rule is allowed; the list exists for exceptions', () => {
    const project = create();
    expect(project.isAliasAllowed('chat-fast')).toBe(true);

    project.setModelRules([{ alias: 'chat-expensive', allowed: false }], NOW);
    expect(project.isAliasAllowed('chat-expensive')).toBe(false);
    expect(project.isAliasAllowed('chat-fast')).toBe(true);
  });

  it('the policy version increments on every change, to invalidate the router cache', () => {
    const project = create();
    expect(project.policyVersion).toBe(1);

    project.setMaxConcurrentRequests(5, NOW);
    expect(project.policyVersion).toBe(2);

    project.setModelRules([], NOW);
    expect(project.policyVersion).toBe(3);
  });

  it('rejects a maximum concurrency below 1', () => {
    expect(() => {
      create().setMaxConcurrentRequests(0, NOW);
    }).toThrow(ValidationError);
  });
});

/**
 * Retention as a project decision (reference doc 02 §10.2).
 *
 * It used to be an environment variable per service, so every project in a
 * deployment kept its content for exactly as long as every other -- and the
 * LGPD procedure had nothing per project to act on.
 */
describe('Project content retention', () => {
  it('starts at ninety days, which is the documented default', () => {
    expect(create().contentRetentionDays).toBe(90);
  });

  it('can be set to something shorter or longer', () => {
    const project = create();

    project.setContentRetentionDays(30, NOW);
    expect(project.contentRetentionDays).toBe(30);

    project.setContentRetentionDays(365, NOW);
    expect(project.contentRetentionDays).toBe(365);
  });

  it('refuses zero, a negative number and a fraction of a day', () => {
    const project = create();

    expect(() => {
      project.setContentRetentionDays(0, NOW);
    }).toThrow(ValidationError);
    expect(() => {
      project.setContentRetentionDays(-1, NOW);
    }).toThrow(ValidationError);
    expect(() => {
      project.setContentRetentionDays(1.5, NOW);
    }).toThrow(ValidationError);
  });

  it('refuses a retention nobody chose deliberately', () => {
    // Ten years is not a technical limit. Keeping personal data longer is a
    // decision with a legal basis behind it, and a form that accepts 99999 has
    // made that decision on somebody's behalf.
    expect(() => {
      create().setContentRetentionDays(99_999, NOW);
    }).toThrow(ValidationError);
  });

  it('counts as a policy change, so the router invalidates its cache', () => {
    const project = create();
    const before = project.policyVersion;

    project.setContentRetentionDays(30, NOW);

    expect(project.policyVersion).toBeGreaterThan(before);
  });
});

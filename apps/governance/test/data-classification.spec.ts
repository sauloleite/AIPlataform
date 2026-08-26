import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { DataClassification } from '../src/modules/projects/domain/value-objects/data-classification.js';

describe('DataClassification (ADR-010)', () => {
  it('restrito so permite processamento local', () => {
    const restrito = DataClassification.of('restrito');
    expect(restrito.allowedZones()).toEqual(['local']);
    expect(restrito.permits('local')).toBe(true);
    expect(restrito.permits('us')).toBe(false);
    expect(restrito.requiresLocalOnly).toBe(true);
  });

  it('confidencial nao sai do pais', () => {
    const confidencial = DataClassification.of('confidencial');
    expect(confidencial.allowedZones()).toEqual(['local', 'br']);
    expect(confidencial.permits('global')).toBe(false);
  });

  it('interno pode usar provedor externo', () => {
    expect(DataClassification.of('interno').permits('us')).toBe(true);
  });

  it('restrictTo nunca AMPLIA o que a classificacao permite', () => {
    const restrito = DataClassification.of('restrito');
    // Pedir 'us' nao habilita 'us' para um projeto restrito.
    expect(restrito.restrictTo(['local', 'us', 'global'])).toEqual(['local']);
  });

  it('restrictTo consegue reduzir dentro do permitido', () => {
    expect(DataClassification.of('interno').restrictTo(['local', 'br'])).toEqual(['local', 'br']);
  });

  it('recusa classificacao desconhecida', () => {
    expect(() => DataClassification.of('secretissimo')).toThrow(ValidationError);
  });
});

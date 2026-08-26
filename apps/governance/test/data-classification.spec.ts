import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/errors';
import { DataClassification } from '../src/modules/projects/domain/value-objects/data-classification.js';

describe('DataClassification (ADR-010)', () => {
  it('restricted only permits local processing', () => {
    const restrito = DataClassification.of('restricted');
    expect(restrito.allowedZones()).toEqual(['local']);
    expect(restrito.permits('local')).toBe(true);
    expect(restrito.permits('us')).toBe(false);
    expect(restrito.requiresLocalOnly).toBe(true);
  });

  it('confidential does not leave the country', () => {
    const confidencial = DataClassification.of('confidential');
    expect(confidencial.allowedZones()).toEqual(['local', 'br']);
    expect(confidencial.permits('global')).toBe(false);
  });

  it('internal may use an external provider', () => {
    expect(DataClassification.of('internal').permits('us')).toBe(true);
  });

  it('restrictTo never WIDENS what the classification allows', () => {
    const restrito = DataClassification.of('restricted');
    // Asking for 'us' does not enable 'us' for a restricted project.
    expect(restrito.restrictTo(['local', 'us', 'global'])).toEqual(['local']);
  });

  it('restrictTo can narrow within what is permitted', () => {
    expect(DataClassification.of('internal').restrictTo(['local', 'br'])).toEqual(['local', 'br']);
  });

  it('rejects an unknown classification', () => {
    expect(() => DataClassification.of('ultra-secret')).toThrow(ValidationError);
  });
});

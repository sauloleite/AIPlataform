import { describe, expect, it } from 'vitest';
import {
  classificationLabel,
  isClassification,
  isLocalOnly,
  permits,
  zonesFor,
} from '../src/modules/console/domain/classification';

describe('data classification (ADR-010)', () => {
  it('confines a restricted project to the local zone', () => {
    expect(zonesFor('restricted')).toEqual(['local']);
    expect(permits('restricted', 'us')).toBe(false);
    expect(permits('restricted', 'local')).toBe(true);
    expect(isLocalOnly('restricted')).toBe(true);
  });

  it('keeps a confidential project inside local and br', () => {
    expect(zonesFor('confidential')).toEqual(['local', 'br']);
    expect(permits('confidential', 'global')).toBe(false);
    expect(isLocalOnly('confidential')).toBe(false);
  });

  it('lets internal and public reach any zone', () => {
    for (const zone of ['local', 'br', 'us', 'eu', 'global'] as const) {
      expect(permits('internal', zone)).toBe(true);
      expect(permits('public', zone)).toBe(true);
    }
  });

  it('fails CLOSED on an unknown classification', () => {
    // A classification the console does not recognise must not be treated as
    // permissive. If the platform ever adds one, the console shows nothing
    // rather than claiming a zone is allowed.
    expect(isClassification('secreto')).toBe(false);
    expect(permits('secreto', 'local')).toBe(false);
    expect(isLocalOnly('secreto')).toBe(false);
  });

  it('shows an unknown classification verbatim rather than blanking it', () => {
    expect(classificationLabel('restricted')).toBe('Restricted');
    expect(classificationLabel('secreto')).toBe('secreto');
  });
});

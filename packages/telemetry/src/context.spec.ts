import { describe, expect, it } from 'vitest';
import { AIA_ATTR } from './attributes.js';
import { businessAttributes } from './context.js';

describe('businessAttributes', () => {
  it('sempre carrega o project_id, que e o tenant da plataforma', () => {
    expect(businessAttributes({ projectId: 'proj-1' })).toEqual({
      [AIA_ATTR.PROJECT_ID]: 'proj-1',
    });
  });

  it('omite os atributos opcionais ausentes em vez de emitir undefined', () => {
    const attributes = businessAttributes({
      projectId: 'proj-1',
      principalId: 'user-7',
      dataClassification: 'confidencial',
    });

    expect(attributes[AIA_ATTR.PRINCIPAL_ID]).toBe('user-7');
    expect(attributes[AIA_ATTR.DATA_CLASSIFICATION]).toBe('confidencial');
    expect(AIA_ATTR.ALIAS in attributes).toBe(false);
  });
});

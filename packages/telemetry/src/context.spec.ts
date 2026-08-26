import { describe, expect, it } from 'vitest';
import { AIA_ATTR } from './attributes.js';
import { businessAttributes } from './context.js';

describe('businessAttributes', () => {
  it('always carries project_id, the platform tenant', () => {
    expect(businessAttributes({ projectId: 'proj-1' })).toEqual({
      [AIA_ATTR.PROJECT_ID]: 'proj-1',
    });
  });

  it('omits absent optional attributes instead of emitting undefined', () => {
    const attributes = businessAttributes({
      projectId: 'proj-1',
      principalId: 'user-7',
      dataClassification: 'confidential',
    });

    expect(attributes[AIA_ATTR.PRINCIPAL_ID]).toBe('user-7');
    expect(attributes[AIA_ATTR.DATA_CLASSIFICATION]).toBe('confidential');
    expect(AIA_ATTR.ALIAS in attributes).toBe(false);
  });
});

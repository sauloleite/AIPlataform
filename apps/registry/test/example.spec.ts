import { describe, expect, it } from 'vitest';
import { Example } from '../src/modules/core/application/use-cases/example.js';

/**
 * Fakes, not mocks: the test verifies BEHAVIOUR, not the sequence of calls. A
 * test tied to mocks breaks on every refactor without pointing at any real
 * defect.
 */
describe('Example', () => {
  it('returns an identifier', async () => {
    const useCase = new Example(
      { now: () => new Date('2026-01-01T00:00:00Z') },
      { next: () => 'id-1' },
    );

    await expect(useCase.execute({ projectId: 'proj-1' })).resolves.toEqual({ id: 'id-1' });
  });
});

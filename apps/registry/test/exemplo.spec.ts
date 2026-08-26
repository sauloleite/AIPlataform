import { describe, expect, it } from 'vitest';
import { Exemplo } from '../src/modules/core/application/use-cases/exemplo.js';

/**
 * Fakes, nao mocks: o teste verifica COMPORTAMENTO, e nao a sequencia de
 * chamadas. Um teste amarrado a mocks quebra em toda refatoracao sem indicar
 * nenhum defeito real.
 */
describe('Exemplo', () => {
  it('devolve um identificador', async () => {
    const useCase = new Exemplo(
      { now: () => new Date('2026-01-01T00:00:00Z') },
      { next: () => 'id-1' },
    );

    await expect(useCase.execute({ projectId: 'proj-1' })).resolves.toEqual({ id: 'id-1' });
  });
});

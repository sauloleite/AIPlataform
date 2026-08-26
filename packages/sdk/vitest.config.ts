import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // Esqueleto do SDK publico; o conteudo entra na Fase 4 do roadmap.
    passWithNoTests: true,
  },
});

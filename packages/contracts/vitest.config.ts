import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // Este pacote so contem tipos gerados a partir dos contratos. O que o
    // valida e o job `contracts` do CI, que regera e falha se o resultado
    // divergir do commitado.
    passWithNoTests: true,
  },
});

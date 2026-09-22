import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next needs `jsx: preserve` in tsconfig -- it compiles JSX itself -- and the
  // transformer here reads that and leaves JSX in place, which Node cannot run.
  // Only the tests that render a component need it compiled; Next is untouched.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Only the layers that hold rules. React components are covered by the
      // end-to-end flow, not by a coverage threshold that rewards shallow tests.
      include: ['src/modules/**/domain/**', 'src/modules/**/application/**'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});

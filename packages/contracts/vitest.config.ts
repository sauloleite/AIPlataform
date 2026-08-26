import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // This package holds nothing but types generated from the contracts. What
    // validates it is the `contracts` CI job, which regenerates them and fails if
    // the result differs from what was committed.
    passWithNoTests: true,
  },
});

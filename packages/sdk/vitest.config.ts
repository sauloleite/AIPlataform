import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // Skeleton of the public SDK; the content arrives in roadmap phase 4.
    passWithNoTests: true,
  },
});

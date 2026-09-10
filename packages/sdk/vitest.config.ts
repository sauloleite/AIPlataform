import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `test/` as well as `src/`. The sdk's tests live in `test/`, unlike every
    // other package here, and the config included only `src/**` — so the whole
    // suite reported success while running nothing. `passWithNoTests` was the
    // other half of it: written when this package was a placeholder, it turned
    // "there are no tests" from an error into a green tick, and it stayed after
    // the tests arrived.
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
  },
});

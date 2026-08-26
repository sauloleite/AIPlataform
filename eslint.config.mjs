// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.nx/**',
      '**/generated/**',
      'docs/reference/**',
      // The Python virtualenv brings in third-party libraries' JS.
      '.venv/**',
      '**/__pycache__/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Each package has `tsconfig.json` (editor and lint, includes tests)
        // and `tsconfig.build.json` (emits to dist, no tests). projectService
        // finds the former on its own, which is what lets the typed rules run
        // on test files too.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Clean Code (reference doc 03 §5): typed errors, nothing swallowed.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // The rule applies to FUNCTIONS: more than four positional arguments is
      // a sign a command object is missing. A constructor with dependency
      // injection is a different thing — it is a list of collaborators, filled
      // in by the framework, and capping it would only push towards an
      // artificial wiring object. Hence the selector excludes constructors.
      'max-params': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration[params.length>4]',
          message: 'Mais de quatro parametros: use um objeto de comando.',
        },
        {
          selector: 'ArrowFunctionExpression[params.length>4]',
          message: 'Mais de quatro parametros: use um objeto de comando.',
        },
        {
          selector: "MethodDefinition[kind!='constructor'] > FunctionExpression[params.length>4]",
          message: 'Mais de quatro parametros: use um objeto de comando.',
        },
      ],
      complexity: ['error', 15],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      // `process.env['X']` is the correct form under noUncheckedIndexedAccess.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      'prefer-const': 'error',
      // It clashes with the ports pattern: a port declares `Promise<T>`, and an
      // in-memory adapter satisfies the contract with nothing to await. Flagging
      // that as an error would push towards a decorative `Promise.resolve()`.
      '@typescript-eslint/require-await': 'off',
      // `no-useless-constructor` does not see that widening a `protected`
      // constructor to `public` IS the purpose of the subclass constructor.
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Tests can be looser about types and may use console.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      complexity: 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'max-params': 'off',
    },
  },
  {
    // Config files and scripts sit OUTSIDE any tsconfig, so the rules that need
    // type information cannot run on them.
    // The `disableTypeChecked` rules have to be MERGED: overwriting `rules`
    // after the spread would erase exactly what switches those rules off.
    files: ['tools/**/*.mjs', '**/*.config.mjs', '**/*.config.ts', '*.cjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // A NestJS module is an empty class by design: it exists to carry the
    // decorator metadata.
    files: ['**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  prettier,
);

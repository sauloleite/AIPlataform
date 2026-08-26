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
      // Ambiente virtual do Python traz JS de bibliotecas de terceiros.
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
        // `tsconfig.eslint.json` inclui testes e configs, que ficam fora do
        // build. Sem isso, as regras tipadas nao rodam neles.
        // Cada pacote tem `tsconfig.json` (editor e lint, inclui testes) e
        // `tsconfig.build.json` (emite para dist, sem testes). O projectService
        // acha o primeiro sozinho.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Clean Code (doc 03, secao 5): erros tipados, nada engolido.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A regra vale para FUNCOES: mais de quatro argumentos posicionais e
      // sinal de que falta um objeto de comando. Um construtor com injecao de
      // dependencia e outra coisa — e uma lista de colaboradores, preenchida
      // pelo framework, e limita-la so empurraria para um objeto de wiring
      // artificial. Por isso o seletor exclui construtores.
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
      // `process.env['X']` e a forma correta com noUncheckedIndexedAccess.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      'prefer-const': 'error',
      // Conflita com o padrao de ports: um port declara `Promise<T>`, e um
      // adapter em memoria cumpre o contrato sem ter o que aguardar. Marcar
      // isso como erro empurraria para `Promise.resolve()` decorativo.
      '@typescript-eslint/require-await': 'off',
      // `no-useless-constructor` nao enxerga que tornar um construtor
      // `protected` em `public` E o proposito do construtor na subclasse.
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Testes podem ser mais soltos com tipos e podem usar console.
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
    // Arquivos de configuracao e scripts ficam FORA de qualquer tsconfig, entao
    // as regras que exigem informacao de tipo nao conseguem rodar neles.
    // As regras de `disableTypeChecked` precisam ser MESCLADAS: sobrescrever
    // `rules` depois do spread apagaria justamente o que desliga essas regras.
    files: ['tools/**/*.mjs', '**/*.config.mjs', '**/*.config.ts', '*.cjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // Modulo do NestJS e uma classe vazia por design: ela existe para carregar
    // os metadados do decorator.
    files: ['**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  prettier,
);

/**
 * Regra de dependencia da Clean Architecture (doc 03, secao 3.1).
 * Dependencias apontam para dentro: presentation -> application -> domain.
 * Infraestrutura implementa ports e so e referenciada pelo wiring (*.module.ts, container.ts).
 *
 * Este arquivo falha o build. Nao relaxe uma regra sem um ADR.
 */

/** Pacotes que caracterizam framework, I/O ou provedor externo. */
const FRAMEWORK_PACKAGES = [
  '^@nestjs',
  '^express',
  '^fastify',
  '^mongoose',
  '^mongodb',
  '^ioredis',
  '^redis$',
  '^bullmq',
  '^axios',
  '^undici',
  '^node-fetch',
  '^openai',
  '^@anthropic-ai',
  '^@google',
  '^@qdrant',
  '^@aws-sdk',
  '^minio',
  '^@opentelemetry',
  '^jose',
  '^class-validator',
  '^class-transformer',
];

/** Modulos nativos do Node que sinalizam I/O dentro do dominio. */
const NODE_IO_BUILTINS = [
  '^fs$',
  '^node:fs',
  '^net$',
  '^node:net',
  '^http$',
  '^node:http',
  '^https$',
  '^node:https',
  '^dns$',
  '^node:dns',
  '^child_process$',
  '^node:child_process',
];

module.exports = {
  forbidden: [
    {
      name: 'dominio-nao-conhece-infraestrutura',
      severity: 'error',
      comment:
        'domain/ e TypeScript puro. Persistencia, HTTP e provedores ficam atras de ports em application/ports.',
      from: { path: '(^|/)domain/' },
      to: { path: '(^|/)(infrastructure|presentation)/' },
    },
    {
      name: 'dominio-nao-conhece-aplicacao',
      severity: 'error',
      comment: 'A dependencia aponta para dentro: application conhece domain, nunca o contrario.',
      from: { path: '(^|/)domain/' },
      to: { path: '(^|/)application/' },
    },
    {
      name: 'dominio-nao-conhece-framework',
      severity: 'error',
      comment:
        'Nenhum decorator de framework, cliente de banco ou SDK de provedor dentro de domain/.',
      from: { path: '(^|/)domain/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'],
        path: FRAMEWORK_PACKAGES,
      },
    },
    {
      name: 'dominio-nao-faz-io',
      severity: 'error',
      comment: 'domain/ nao le arquivo, nao abre socket e nao chama processo.',
      from: { path: '(^|/)domain/' },
      to: { dependencyTypes: ['core'], path: NODE_IO_BUILTINS },
    },
    {
      name: 'aplicacao-nao-conhece-infraestrutura',
      severity: 'error',
      comment:
        'Casos de uso dependem de ports (interfaces), nunca de adapters. O wiring resolve isso.',
      from: { path: '(^|/)application/' },
      to: { path: '(^|/)(infrastructure|presentation)/' },
    },
    {
      name: 'aplicacao-nao-conhece-http',
      severity: 'error',
      comment: 'Casos de uso recebem comandos, nunca Request do Express (doc 03, secao 3.2).',
      from: { path: '(^|/)application/' },
      to: { dependencyTypes: ['npm'], path: ['^express', '^fastify', '^@nestjs/platform'] },
    },
    {
      name: 'apresentacao-nao-instancia-adapter',
      severity: 'error',
      comment:
        'Controllers falam com casos de uso. Adapters chegam por injecao; o wiring vive em *.module.ts.',
      from: { path: '(^|/)presentation/', pathNot: '\\.module\\.ts$' },
      to: { path: '(^|/)infrastructure/' },
    },
    {
      name: 'servico-nao-importa-dominio-de-outro',
      severity: 'error',
      comment:
        'Nenhum servico importa codigo de dominio de outro (doc 02, secao 5). Use contratos.',
      from: { path: '^apps/([^/]+)/' },
      to: {
        path: '^apps/(?!$1)[^/]+/',
        pathNot: '^apps/[^/]+/(dist|node_modules)/',
      },
    },
    {
      name: 'pacote-compartilhado-nao-depende-de-servico',
      severity: 'error',
      comment: 'packages/ e reutilizavel: nao conhece nenhum apps/.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'sem-dependencia-circular',
      severity: 'error',
      comment: 'Ciclo de import indica fronteira errada entre modulos.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'sem-orfaos',
      severity: 'warn',
      comment: 'Arquivo que ninguem importa costuma ser codigo morto.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '\\.d\\.ts$',
          '(^|/)(index|main)\\.ts$',
          '\\.(spec|test)\\.ts$',
          '(^|/)tsconfig[^/]*\\.json$',
          // Arquivos de configuracao sao carregados pela ferramenta, nao importados.
          '\\.config\\.(ts|mts|cts|js|mjs|cjs)$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|coverage|\\.nx)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};

/**
 * The Clean Architecture dependency rule (reference doc 03 §3.1).
 * Dependencies point inwards: presentation -> application -> domain.
 * Infrastructure implements ports and is referenced only by the wiring
 * (*.module.ts, container.ts).
 *
 * This file fails the build. Do not relax a rule without an ADR.
 */

/** Packages that mark a framework, I/O or an external provider. */
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

/** Node built-ins that signal I/O inside the domain. */
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
      name: 'domain-does-not-know-infrastructure',
      severity: 'error',
      comment:
        'domain/ is plain TypeScript. Persistence, HTTP and providers sit behind ports in application/ports.',
      from: { path: '(^|/)domain/' },
      to: { path: '(^|/)(infrastructure|presentation)/' },
    },
    {
      name: 'domain-does-not-know-application',
      severity: 'error',
      comment:
        'The dependency points inwards: application knows domain, never the other way round.',
      from: { path: '(^|/)domain/' },
      to: { path: '(^|/)application/' },
    },
    {
      name: 'domain-does-not-know-frameworks',
      severity: 'error',
      comment: 'No framework decorator, database client or provider SDK inside domain/.',
      from: { path: '(^|/)domain/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'],
        path: FRAMEWORK_PACKAGES,
      },
    },
    {
      name: 'domain-does-no-io',
      severity: 'error',
      comment: 'domain/ reads no file, opens no socket and spawns no process.',
      from: { path: '(^|/)domain/' },
      to: { dependencyTypes: ['core'], path: NODE_IO_BUILTINS },
    },
    {
      name: 'application-does-not-know-infrastructure',
      severity: 'error',
      comment:
        'Use cases depend on ports (interfaces), never on adapters. The wiring resolves that.',
      from: { path: '(^|/)application/' },
      to: { path: '(^|/)(infrastructure|presentation)/' },
    },
    {
      name: 'application-does-not-know-http',
      severity: 'error',
      comment: 'Use cases take commands, never an Express Request (reference doc 03 §3.2).',
      from: { path: '(^|/)application/' },
      to: { dependencyTypes: ['npm'], path: ['^express', '^fastify', '^@nestjs/platform'] },
    },
    {
      name: 'presentation-does-not-instantiate-adapters',
      severity: 'error',
      comment:
        'Controllers talk to use cases. Adapters arrive by injection; the wiring lives in *.module.ts.',
      from: { path: '(^|/)presentation/', pathNot: '\\.module\\.ts$' },
      to: { path: '(^|/)infrastructure/' },
    },
    {
      name: 'next-app-router-does-not-instantiate-adapters',
      severity: 'error',
      comment:
        "Next's App Router IS the presentation layer, but it cannot be renamed to presentation/ -- the framework requires src/app. Pages and route handlers reach an adapter through container.ts, never directly.",
      from: { path: '^apps/web/src/app/', pathNot: '^apps/web/src/container\\.ts$' },
      to: { path: '(^|/)infrastructure/' },
    },
    {
      name: 'no-service-imports-another-services-domain',
      severity: 'error',
      comment:
        "No service imports another service's domain code (reference doc 02 §5). Use contracts.",
      from: { path: '^apps/([^/]+)/' },
      to: {
        path: '^apps/(?!$1)[^/]+/',
        pathNot: '^apps/[^/]+/(dist|node_modules)/',
      },
    },
    {
      name: 'shared-package-does-not-depend-on-a-service',
      severity: 'error',
      comment: 'packages/ is reusable: it knows no apps/.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular-dependency',
      severity: 'error',
      comment: 'An import cycle indicates a wrong boundary between modules.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'A file nobody imports is usually dead code.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '\\.d\\.ts$',
          '(^|/)(index|main)\\.ts$',
          '\\.(spec|test)\\.ts$',
          '(^|/)tsconfig[^/]*\\.json$',
          // Config files are loaded by the tool, not imported.
          '\\.config\\.(ts|mts|cts|js|mjs|cjs)$',
          // Next loads these by path, not by import. A page nobody imports is
          // how the App Router works, not dead code.
          '^apps/web/src/app/.*/(page|layout|route|loading|error|not-found)\\.tsx?$',
          '^apps/web/src/app/(page|layout|route|loading|error|not-found)\\.tsx?$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|coverage|\\.nx|\\.next)/' },
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

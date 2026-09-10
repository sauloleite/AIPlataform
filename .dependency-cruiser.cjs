/**
 * The Clean Architecture dependency rule (reference doc 03 §3.1).
 * Dependencies point inwards: presentation -> application -> domain.
 * Infrastructure implements ports and is referenced only by the wiring
 * (*.module.ts, container.ts).
 *
 * This file fails the build. Do not relax a rule without an ADR.
 */

/**
 * Packages that mark a framework, I/O or an external provider.
 *
 * Written as PATH fragments, not as module names. `to.path` matches the
 * RESOLVED path, which under pnpm looks like
 * `node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/ajv.js`. A pattern
 * anchored with `^` — as these were — matches none of them, so the rule below
 * reported success for as long as it existed while the domain was free to
 * import any of them.
 *
 * The trailing slash is what ends the package name: `node_modules/redis/` does
 * not match ioredis, and `node_modules/react/` does not match react-dom.
 */
const FRAMEWORK_PACKAGES = [
  'node_modules/@nestjs/',
  'node_modules/express/',
  'node_modules/fastify/',
  'node_modules/mongoose/',
  'node_modules/mongodb/',
  'node_modules/ioredis/',
  'node_modules/redis/',
  'node_modules/bullmq/',
  'node_modules/axios/',
  'node_modules/undici/',
  'node_modules/node-fetch/',
  'node_modules/openai/',
  'node_modules/@anthropic-ai/',
  'node_modules/@google/',
  'node_modules/@qdrant/',
  'node_modules/@aws-sdk/',
  'node_modules/minio/',
  'node_modules/@opentelemetry/',
  'node_modules/jose/',
  // Ajv compiles JSON Schema. A rule about arguments belongs to the gateway;
  // the dialect that evaluates it is an adapter's business.
  'node_modules/ajv/',
  'node_modules/class-validator/',
  'node_modules/class-transformer/',
  'node_modules/@fluentui/',
  'node_modules/@griffel/',
  'node_modules/react/',
  'node_modules/react-dom/',
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
    // `doNotFollow` keeps an npm package in the graph as a LEAF: the edge to it
    // is recorded, its own imports are not traversed. `exclude` would drop the
    // module from the graph altogether -- and with it every edge pointing at
    // it, which is why `node_modules` must not appear below.
    //
    // It did, and the consequence was silent: `domain-does-not-know-frameworks`
    // matched nothing for as long as it existed, so a domain file was free to
    // import @nestjs, mongodb, ioredis or a provider SDK. The rule reported
    // success because there was nothing left in the graph to report on.
    doNotFollow: { path: 'node_modules' },
    // Scoped to THIS repository's build output with a negative lookahead. The
    // pattern used to be `(^|/)(dist|...)/`, which also matched
    // `node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/ajv.js` -- so every
    // package whose entry point happens to live under `dist/` vanished from the
    // graph, and no rule could say anything about it.
    // ANCHORED at the repository root, so it can only ever match this project's
    // own build output. The pattern used to be `(^|/)(dist|...)/`, which also
    // matched `node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/ajv.js` --
    // so every package whose entry point happens to live under `dist/` vanished
    // from the graph, and no rule could say anything about it.
    exclude: {
      path: '^(apps|packages|tools)/[^/]+/(dist|coverage|\\.next)/|^(dist|coverage|\\.nx|\\.next)/',
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      // .tsx and .jsx belong here: without them every extensionless import of a
      // React component dead-ends, and the graph silently stops at the App
      // Router's client components instead of following through them.
      extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};

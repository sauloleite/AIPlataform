import type { NextConfig } from 'next';

const config: NextConfig = {
  // A standalone build is what the distroless image can run: Next traces the
  // files it actually needs and copies them, so the image carries no pnpm
  // workspace symlinks.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  reactStrictMode: true,
  // `@aia/contracts` is types only, but Next still resolves the workspace link.
  // Fluent is deliberately NOT here: it ships dual ESM/CJS behind a correct
  // exports map, and transpiling it would cost minutes per build for nothing.
  transpilePackages: ['@aia/contracts'],
  poweredByHeader: false,
  experimental: {
    // Fluent is not in Next's built-in list, and its barrel is large enough
    // that every import would otherwise walk the whole thing on each compile.
    optimizePackageImports: ['@fluentui/react-components', '@fluentui/react-icons'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The theme is resolved server-side (see domain/theme.ts). Asking for
          // this hint is what lets a first visit with no cookie still render the
          // user's OS preference instead of flashing.
          // No `Vary` alongside these: Next replaces it with its own RSC list,
          // and every response here is `no-store` anyway, so nothing may cache
          // one theme and serve it to the other.
          { key: 'Accept-CH', value: 'Sec-CH-Prefers-Color-Scheme' },
          { key: 'Critical-CH', value: 'Sec-CH-Prefers-Color-Scheme' },
        ],
      },
    ];
  },
};

export default config;

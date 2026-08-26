import type { NextConfig } from 'next';

const config: NextConfig = {
  // A standalone build is what the distroless image can run: Next traces the
  // files it actually needs and copies them, so the image carries no pnpm
  // workspace symlinks.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  reactStrictMode: true,
  // `@aia/contracts` is types only, but Next still resolves the workspace link.
  transpilePackages: ['@aia/contracts'],
  poweredByHeader: false,
};

export default config;

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// One id for the build, used as Next's build id and as the service worker's version (?v= on its URL),
// so every deploy installs fresh caches. GIT_SHA / SOURCE_VERSION come from CI; else a timestamp.
const buildId = process.env.GIT_SHA ?? process.env.SOURCE_VERSION ?? Date.now().toString(36);

const config: NextConfig = {
  generateBuildId: () => buildId,
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  transpilePackages: ['@mondapac/panel-server'],
  poweredByHeader: false,
  // `next dev` writes an AGENTS.md into the app folder; the repository keeps its agent rules elsewhere.
  agentRules: false,
  headers() {
    return Promise.resolve([
      {
        // The browser must re-check the worker script on every visit (a stale worker is stuck for good).
        // Its scope is "/" because it is served from the root, so no Service-Worker-Allowed header.
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]);
  },
};

export default withNextIntl(config);

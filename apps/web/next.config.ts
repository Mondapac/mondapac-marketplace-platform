import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  transpilePackages: ['@mondapac/panel-server'],
  poweredByHeader: false,
  // `next dev` writes an AGENTS.md into the app folder; the repository keeps its agent rules elsewhere.
  agentRules: false,
  headers() {
    return Promise.resolve([
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

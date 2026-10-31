import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Settings pages moved under /settings (settings hub). The old addresses keep working with a
// permanent redirect, so bookmarks and links in sent emails still land on the page. The query
// string is kept (Next.js passes it through a redirect).
export const settingsRedirects = [
  { source: '/store-profile', destination: '/settings/store-profile' },
  { source: '/stock-locations', destination: '/settings/stock-locations' },
  { source: '/payout-account', destination: '/settings/payout-account' },
  { source: '/team', destination: '/settings/team' },
].map((redirect) => ({ ...redirect, permanent: true as const }));

const config: NextConfig = {
  transpilePackages: ['@mondapac/ui', '@mondapac/panel-server'],
  poweredByHeader: false,
  // `next dev` writes an AGENTS.md into the app folder; the repository keeps its agent rules elsewhere.
  agentRules: false,
  // The combined store-profile save carries both pictures (the BFF allows up to 2 x the photo cap);
  // Next's proxy buffer defaults to 10 MB.
  experimental: { proxyClientMaxBodySize: '60mb' },
  redirects: () => Promise.resolve(settingsRedirects),
};

export default withNextIntl(config);

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
  // No proxyClientMaxBodySize here: the proxy does not match `/api/` (see proxy.ts), so the relay
  // body (up to about 11.6 MB for the combined store-profile save) is never cloned by Next and
  // only the relay's own size cap buffers it.
  redirects: () => Promise.resolve(settingsRedirects),
};

export default withNextIntl(config);

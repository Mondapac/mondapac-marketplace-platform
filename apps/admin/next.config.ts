import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Settings pages moved under /settings (settings hub). The old addresses keep working with a
// permanent redirect, so bookmarks and links in sent emails still land on the page. The query
// string is kept. `/wallet/credits` and `/wallet/credit-requests` are not settings and stay put.
export const settingsRedirects = [
  { source: '/delivery-settings', destination: '/settings/delivery' },
  { source: '/fleet-selection', destination: '/settings/fleets' },
  { source: '/wallet', destination: '/settings/wallet' },
  { source: '/team', destination: '/settings/admins' },
  { source: '/roles/:path*', destination: '/settings/roles/:path*' },
].map((redirect) => ({ ...redirect, permanent: true as const }));

const config: NextConfig = {
  transpilePackages: ['@mondapac/ui', '@mondapac/panel-server'],
  poweredByHeader: false,
  // `next dev` writes an AGENTS.md into the app folder; the repository keeps its agent rules elsewhere.
  agentRules: false,
  redirects: () => Promise.resolve(settingsRedirects),
};

export default withNextIntl(config);

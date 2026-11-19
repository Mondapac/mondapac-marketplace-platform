import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Settings pages moved under /settings (settings hub). The old addresses keep working with a
// permanent redirect, so bookmarks and links in sent emails still land on the page. The query
// string is kept (Next.js passes it through a redirect).
// Same as PAYOUT_ACCOUNT_PATH in src/payout/types.ts (redirects.spec.ts checks they agree).
const PAYOUT_ACCOUNT_PATH = '/accounting/payout-account';

export const settingsRedirects = [
  { source: '/store-profile', destination: '/settings/store-profile' },
  { source: '/stock-locations', destination: '/settings/stock-locations' },
  { source: '/team', destination: '/settings/team' },
  // Payout account left Settings for Accounting (menu design v2, 15 Nov 2026). Stripe sends the
  // seller back to /payout-account?stripe=..., and browsers may hold the earlier permanent
  // redirect to /settings/payout-account, so both lead here.
  { source: '/payout-account', destination: PAYOUT_ACCOUNT_PATH },
  { source: '/settings/payout-account', destination: PAYOUT_ACCOUNT_PATH },
].map((redirect) => ({ ...redirect, permanent: true as const }));

const config: NextConfig = {
  transpilePackages: ['@mondapac/ui', '@mondapac/panel-server', '@mondapac/platform-import'],
  poweredByHeader: false,
  // `next dev` writes an AGENTS.md into the app folder; the repository keeps its agent rules elsewhere.
  agentRules: false,
  // No proxyClientMaxBodySize here: the proxy does not match `/api/` (see proxy.ts), so the relay
  // body (up to about 11.6 MB for the combined store-profile save) is never cloned by Next and
  // only the relay's own size cap buffers it.
  redirects: () => Promise.resolve(settingsRedirects),
};

export default withNextIntl(config);

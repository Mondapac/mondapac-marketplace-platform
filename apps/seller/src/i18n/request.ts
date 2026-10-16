import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { panelConfig } from '../server/config.ts';
import { readSellerZone } from '../server/seller-zone.ts';

// The locale is the Market's (PANEL_LOCALE, ADR-0033 decision 10). The message catalogue is still
// the one English one until a Market needs another language. The time zone is the signed-in
// seller's own working zone, read once per request; UTC when there is no session or the read
// fails, so a page never shows a time in the server's or browser's zone.
export default getRequestConfig(async () => {
  const jar = await cookies();
  const signedIn = jar.getAll().some((c) => c.name.startsWith('__Host-session-seller-'));
  const zone = signedIn ? await readSellerZone() : null;
  return {
    locale: panelConfig().locale,
    timeZone: zone ?? 'UTC',
    messages: (await import('../../messages/en.json')).default,
  };
});

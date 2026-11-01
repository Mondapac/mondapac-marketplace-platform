// Which GA4 measurement ID, if any, serves this request (SEO package 7). Off by default: no ID
// for the request's Market means no tag, no CSP change and no analytics row in the cookie
// settings. The ID comes from STOREFRONT_GA4_IDS (`MARKET=G-XXXX` pairs, comma separated) and
// the Market from the request's host, the same way the API reads are matched
// (src/storefront/hosts.ts). Admin SEO settings (plans/seo-admin-settings.md 2.3) will move the
// ID to the panel: keep every read in `ga4IdFor`, so only its source changes.
// No server-only marker: the proxy builds the CSP from it.
import { hostFor, parseStorefrontHosts } from '../storefront/hosts.ts';

/** A GA4 web stream's measurement ID. */
export const GA4_ID = /^G-[A-Z0-9]{6,12}$/;

type Env = Readonly<Record<string, string | undefined>>;

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[analytics] ${message}`);
}

/**
 * The valid `MARKET=G-XXXX` pairs. An invalid entry is left out (analytics stays off for that
 * Market) and logged once, never thrown: a wrong analytics ID must not take the shop down.
 */
export function parseGa4Ids(raw: string | undefined): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    if (entry.trim() === '') continue;
    const separator = entry.indexOf('=');
    const market = entry.slice(0, separator).trim();
    const id = entry.slice(separator + 1).trim();
    if (separator < 1 || !/^[A-Z]{2}$/.test(market) || !GA4_ID.test(id)) {
      warnOnce(
        `STOREFRONT_GA4_IDS: '${market || entry.trim()}' is not MARKET=G-XXXX; analytics is off for it`,
      );
      continue;
    }
    ids.set(market, id);
  }
  return ids;
}

/** The measurement ID of the Market the request's `Host` header belongs to; null: analytics off. */
export function ga4IdFor(rawHost: string | null, env: Env = process.env): string | null {
  const ids = parseGa4Ids(env['STOREFRONT_GA4_IDS']);
  if (ids.size === 0) return null;
  let hosts;
  try {
    hosts = parseStorefrontHosts(env['STOREFRONT_HOSTS']);
  } catch {
    warnOnce('STOREFRONT_HOSTS is missing or malformed; analytics is off');
    return null;
  }
  const market = hostFor(hosts, rawHost)?.marketId;
  return market === undefined ? null : (ids.get(market) ?? null);
}

// Where the sell page's "Already selling? Sign in" goes: the seller panel's sign-in page of the
// request's Market (identity.links.targets.seller.sign-in in config/markets/<ID>.json), from
// SELLER_SIGN_IN_URLS. Seller and customer accounts are separate, so the link always leaves the
// buyer site, and it must be https (http only on *.localhost) (Hassan, PR #442).
import 'server-only';
import type { StorefrontHost } from './config.ts';

const MARKET_ID = /^[A-Z]{2}$/;
const LOCAL_HOST = /^[a-z0-9-]+\.localhost(:\d+)?$/;

/**
 * Parses `MARKET=url,MARKET=url`; empty is `{}` (the sample page stays). Throws on anything
 * malformed, on a page served from a storefront host, or when a listed host's Market has none.
 */
export function parseSellerSignInUrls(
  raw: string | undefined,
  hosts: readonly StorefrontHost[],
): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim() === '') return {};
  const urls: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`SELLER_SIGN_IN_URLS: '${entry.trim()}' is not MARKET=url`);
    const marketId = entry.slice(0, separator).trim();
    const text = entry.slice(separator + 1).trim();
    if (!MARKET_ID.test(marketId)) {
      throw new Error(`SELLER_SIGN_IN_URLS: '${marketId}' is not a Market code`);
    }
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`SELLER_SIGN_IN_URLS: '${text}' is not a URL`);
    }
    const secure =
      url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOST.test(url.host));
    if (!secure || url.username !== '' || url.password !== '') {
      throw new Error(`SELLER_SIGN_IN_URLS: '${text}' must use https (http only on *.localhost)`);
    }
    if (hosts.some((host) => host.host === url.host)) {
      throw new Error(`SELLER_SIGN_IN_URLS: '${text}' must be on the seller panel's host`);
    }
    if (marketId in urls) throw new Error(`SELLER_SIGN_IN_URLS: '${marketId}' is listed twice`);
    urls[marketId] = url.href;
  }
  for (const host of hosts) {
    if (!(host.marketId in urls)) {
      throw new Error(`SELLER_SIGN_IN_URLS: no sign-in page for Market '${host.marketId}'`);
    }
  }
  return urls;
}

let cached: Readonly<Record<string, string>> | undefined;

/** The seller sign-in pages of this process, read once; {} while API_BASE_URL is empty. */
export function sellerSignInUrls(config: { readonly hosts: readonly StorefrontHost[] } | null) {
  cached ??=
    config === null ? {} : parseSellerSignInUrls(process.env['SELLER_SIGN_IN_URLS'], config.hosts);
  return cached;
}

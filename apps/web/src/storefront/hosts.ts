// The buyer site's host list (STOREFRONT_HOSTS). No server-only marker: the proxy (CSP) reads it
// too, and it only parses text.

export interface StorefrontHost {
  /** `scheme://host[:port]`, exactly what a browser sends in `Origin`. */
  readonly origin: string;
  /** `host[:port]`, lower case, as a browser sends in `Host`. */
  readonly host: string;
  readonly marketId: string;
}

const MARKET_ID = /^[A-Z]{2}$/;
export const LOCAL_HOST = /^[a-z0-9-]+\.localhost(:\d+)?$/;
/** Parses `origin=MARKET,origin=MARKET`. Throws on anything malformed, so start-up fails. */
export function parseStorefrontHosts(raw: string | undefined): readonly StorefrontHost[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'STOREFRONT_HOSTS is required with API_BASE_URL: origin=MARKET pairs, for example ' +
        'http://storefront.localhost:3003=AU',
    );
  }
  const hosts: StorefrontHost[] = [];
  for (const entry of raw.split(',')) {
    const separator = entry.lastIndexOf('=');
    if (separator < 1) throw new Error(`STOREFRONT_HOSTS: '${entry.trim()}' is not origin=MARKET`);
    const originText = entry.slice(0, separator).trim();
    const marketId = entry.slice(separator + 1).trim();
    let url: URL;
    try {
      url = new URL(originText);
    } catch {
      throw new Error(`STOREFRONT_HOSTS: '${originText}' is not an origin`);
    }
    if (url.origin !== originText || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw new Error(
        `STOREFRONT_HOSTS: '${originText}' must be scheme://host[:port] with no path`,
      );
    }
    if (url.protocol === 'http:' && !LOCAL_HOST.test(url.host)) {
      throw new Error(
        `STOREFRONT_HOSTS: '${originText}' must use https (http only on *.localhost)`,
      );
    }
    if (!MARKET_ID.test(marketId)) {
      throw new Error(`STOREFRONT_HOSTS: '${marketId}' is not a Market code`);
    }
    if (hosts.some((existing) => existing.host === url.host)) {
      throw new Error(`STOREFRONT_HOSTS: host '${url.host}' is listed twice`);
    }
    hosts.push({ origin: url.origin, host: url.host, marketId });
  }
  return hosts;
}

/** The listed host a request came to, by its `Host` header. */
export function hostFor(
  hosts: readonly StorefrontHost[],
  rawHost: string | null,
): StorefrontHost | undefined {
  const host =
    rawHost
      ?.trim()
      .toLowerCase()
      .replace(/\.(?=$|:)/, '') ?? '';
  return host === '' ? undefined : hosts.find((entry) => entry.host === host);
}

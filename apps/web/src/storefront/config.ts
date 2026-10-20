// Server-side configuration of the buyer site's API reads (ADR-0037 decision 9; the same rules as
// the panels' apps/admin/src/server/config.ts). Nothing here has a default Market: a host that is
// not listed reads nothing from the API (ADR-0020 decision 3).
import 'server-only';
import { parseClientAddressKey, type ClientAddressKey } from '@mondapac/panel-server/signer';

export interface StorefrontHost {
  /** `scheme://host[:port]`, exactly what a browser sends in `Origin`. */
  readonly origin: string;
  /** `host[:port]`, lower case, as a browser sends in `Host`. */
  readonly host: string;
  readonly marketId: string;
}

export interface StorefrontApiConfig {
  /** The API origin. */
  readonly apiBaseUrl: string;
  readonly hosts: readonly StorefrontHost[];
  /** This site's key for the signed client address; null when it is not set. */
  readonly clientAddressKey: ClientAddressKey | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const MARKET_ID = /^[A-Z]{2}$/;

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

function parseApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API_BASE_URL is not a URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('API_BASE_URL must be an origin with no path');
  }
  return url.origin;
}

/**
 * The API reads' configuration, or null when API_BASE_URL is empty: then the buyer site reads
 * nothing from the API and runs on sample data (the local demo). Throws when it is malformed.
 */
export function parseStorefrontApiConfig(env: Env): StorefrontApiConfig | null {
  const raw = env['API_BASE_URL']?.trim() ?? '';
  if (raw === '') return null;
  return {
    apiBaseUrl: parseApiBaseUrl(raw),
    hosts: parseStorefrontHosts(env['STOREFRONT_HOSTS']),
    clientAddressKey: parseClientAddressKey(env),
  };
}

/**
 * Start-up tripwire (ADR-0037): without the signed client address every buyer shares one
 * per-origin throttle bucket at the API. A host that is not `*.localhost` therefore needs a
 * signing key (BFF_CLIENT_ADDRESS_KEY_ID and BFF_CLIENT_ADDRESS_SECRET).
 */
export function assertClientAddressForwarding(config: StorefrontApiConfig): void {
  const local = config.hosts.every((host) => /^[a-z0-9-]+\.localhost(:\d+)?$/.test(host.host));
  if (local || config.clientAddressKey !== null) return;
  throw new Error(
    'A buyer site on a real host must sign the client address: set BFF_CLIENT_ADDRESS_KEY_ID ' +
      'and BFF_CLIENT_ADDRESS_SECRET (ADR-0037).',
  );
}

/** The listed host a request came to, by its `Host` header. */
export function storefrontHostFor(
  config: StorefrontApiConfig,
  rawHost: string | null,
): StorefrontHost | undefined {
  const host =
    rawHost
      ?.trim()
      .toLowerCase()
      .replace(/\.(?=$|:)/, '') ?? '';
  return host === '' ? undefined : config.hosts.find((entry) => entry.host === host);
}

let cached: { readonly config: StorefrontApiConfig | null } | undefined;

/** The configuration of this process, read once; throws when it is malformed. */
export function storefrontApiConfig(): StorefrontApiConfig | null {
  if (cached === undefined) {
    const config = parseStorefrontApiConfig(process.env);
    if (config !== null) assertClientAddressForwarding(config);
    cached = { config };
  }
  return cached.config;
}
